// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

/**
 * Environment Service
 *
 * Orchestrates Python environment detection across multiple providers
 * (conda/mamba, venv, system). Manages caching and configuration.
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
    PythonDetectionOptions,
    CreateEnvironmentOptions,
    CreateEnvironmentResult,
    CreateEnvironmentCommand
} from '../../../common/nuke-core-protocol';
import { CondaProvider, VenvProvider, SystemProvider, PoetryProvider, PyenvProvider } from './providers';
import { getPythonInfo } from './utils/python-info';

@injectable()
export class EnvironmentService {

    private config: PythonConfig = {};
    private cachedPythonCommand?: string;
    private environmentsCache?: NukeEnvironment[];
    private environmentsCacheTime?: number;
    private readonly CACHE_TTL = 30000; // 30 seconds

    private readonly condaProvider: CondaProvider;
    private readonly venvProvider: VenvProvider;
    private readonly systemProvider: SystemProvider;
    private readonly poetryProvider: PoetryProvider;
    private readonly pyenvProvider: PyenvProvider;

    constructor() {
        this.condaProvider = new CondaProvider();
        this.venvProvider = new VenvProvider();
        this.systemProvider = new SystemProvider();
        this.poetryProvider = new PoetryProvider();
        this.pyenvProvider = new PyenvProvider();
    }

    setConfig(config: PythonConfig): void {
        this.config = { ...config };
        this.clearCache();
    }

    getConfig(): PythonConfig {
        return { ...this.config };
    }

    clearCache(): void {
        this.cachedPythonCommand = undefined;
        this.environmentsCache = undefined;
        this.environmentsCacheTime = undefined;
        this.condaProvider.clearCache();
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
        // 1. Try configured path first
        if (this.config.pythonPath) {
            try {
                const { execSync } = await import('child_process');
                execSync(`"${this.config.pythonPath}" --version`, { stdio: 'ignore' });
                const env = await getPythonInfo(this.config.pythonPath, 'system');
                if (env) {
                    this.cachePythonResult(this.config.pythonPath, env);
                    return { success: true, command: this.config.pythonPath, environment: env };
                }
            } catch {
                // Fall through
            }
        }

        // 2. Try configured conda environment
        if (this.config.condaEnv) {
            const condaPython = await this.condaProvider.findPython(this.config.condaEnv);
            if (condaPython) {
                const env = await getPythonInfo(condaPython, 'conda');
                if (env) {
                    this.cachePythonResult(condaPython, env);
                    return { success: true, command: condaPython, environment: env };
                }
            }
        }

        // 3. Try system Python
        const systemPython = await this.systemProvider.findPython();
        if (systemPython) {
            const env = await getPythonInfo(systemPython, 'system');
            if (env) {
                this.cachePythonResult(systemPython, env);
                return { success: true, command: systemPython, environment: env };
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
                const env = await getPythonInfo(pythonPath, 'system');
                if (!env) {
                    return { success: false, missing: ['Python not valid'], mismatches: [] };
                }

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

        // 1. Try configured Python path first
        if (this.config.pythonPath) {
            try {
                const depCheck = await testPythonWithDeps(this.config.pythonPath);
                if (depCheck.success) {
                    this.cachePythonResult(this.config.pythonPath, depCheck.env!);
                    return { success: true, command: this.config.pythonPath, environment: depCheck.env };
                } else {
                    if (depCheck.missing.length > 0) {
                        const missingPkgs = depCheck.missing.join(', ');
                        const installCmd = this.buildInstallSuggestion(requiredPackages, depCheck.missing);
                        errors.push(`Configured Python missing: ${missingPkgs}`);
                        warnings.push(`Configured Python is missing: ${missingPkgs}. To use it, run: ${installCmd}`);
                    } else {
                        warnings.push(`Configured Python path does not have required packages.`);
                    }
                }
            } catch {
                errors.push(`Configured Python path not valid: ${this.config.pythonPath}`);
            }
        }

        // 2. Try configured conda environment
        if (this.config.condaEnv) {
            const condaPython = await this.condaProvider.findPython(this.config.condaEnv);
            if (condaPython) {
                const depCheck = await testPythonWithDeps(condaPython);
                if (depCheck.success) {
                    this.cachePythonResult(condaPython, depCheck.env!);
                    return { success: true, command: condaPython, warning: warnings.join(' '), environment: depCheck.env };
                } else {
                    const missingPkgs = depCheck.missing.join(', ');
                    const installCmd = this.buildInstallSuggestion(requiredPackages, depCheck.missing);
                    errors.push(`Conda env '${this.config.condaEnv}' missing: ${missingPkgs}`);
                    warnings.push(`Configured conda environment '${this.config.condaEnv}' is missing: ${missingPkgs}. To use it, run: ${installCmd}`);
                }
            } else {
                errors.push(`Conda environment '${this.config.condaEnv}' not found`);
            }
        }

        // 3. Search ALL environments for ones with required packages
        if (requiredPackages.length > 0) {
            const matchingEnvironments = await this.findEnvironmentsWithPackages(requiredPackages, autoDetectEnvs, searchWorkspaceVenvs);

            if (matchingEnvironments.length > 0) {
                const bestMatch = matchingEnvironments[0];
                this.cachePythonResult(bestMatch.pythonPath, bestMatch);
                const pkgList = requiredPackages.map(p => p.name).join(', ');
                const allPkgNames = requiredPackages.map(p => p.name);
                const installCmd = this.buildInstallSuggestion(requiredPackages, allPkgNames);
                const warning = warnings.length > 0
                    ? `${warnings.join(' ')}. Using '${bestMatch.name}' with all required packages.`
                    : `Using '${bestMatch.name}' with required packages (${pkgList}). To use your configured environment, run: ${installCmd}`;
                return { success: true, command: bestMatch.pythonPath, warning, environment: bestMatch };
            }
        }

        // 4. Try auto-detect conda environments by name
        for (const envName of autoDetectEnvs) {
            const condaPython = await this.condaProvider.findPython(envName);
            if (condaPython) {
                const depCheck = await testPythonWithDeps(condaPython);
                if (depCheck.success) {
                    this.cachePythonResult(condaPython, depCheck.env!);
                    const pkgList = requiredPackages.map(p => p.name).join(', ');
                    const allPkgNames = requiredPackages.map(p => p.name);
                    const installCmd = this.buildInstallSuggestion(requiredPackages, allPkgNames);
                    const warning = warnings.length > 0
                        ? `${warnings.join(' ')}. Using auto-detected conda environment '${envName}'.`
                        : `Using '${envName}' with required packages (${pkgList}). To use your configured environment, run: ${installCmd}`;
                    return { success: true, command: condaPython, warning, environment: depCheck.env };
                } else {
                    errors.push(`Auto-detected conda env '${envName}' missing: ${depCheck.missing.join(', ')}`);
                }
            }
        }

        // 5. Try workspace venvs
        if (searchWorkspaceVenvs) {
            const venvEnvs = await this.venvProvider.listEnvironments();
            for (const env of venvEnvs) {
                const depCheck = await testPythonWithDeps(env.pythonPath);
                if (depCheck.success) {
                    this.cachePythonResult(env.pythonPath, depCheck.env!);
                    const pkgList = requiredPackages.map(p => p.name).join(', ');
                    const allPkgNames = requiredPackages.map(p => p.name);
                    const installCmd = this.buildInstallSuggestion(requiredPackages, allPkgNames);
                    const warning = warnings.length > 0
                        ? `${warnings.join(' ')} Using workspace venv '${env.name}'.`
                        : `Using '${env.name}' with required packages (${pkgList}). To use your configured environment, run: ${installCmd}`;
                    return { success: true, command: env.pythonPath, warning, environment: depCheck.env };
                }
            }
        }

        // 6. Try poetry environments
        try {
            const poetryEnvs = await this.poetryProvider.listEnvironments();
            for (const env of poetryEnvs) {
                const depCheck = await testPythonWithDeps(env.pythonPath);
                if (depCheck.success) {
                    this.cachePythonResult(env.pythonPath, depCheck.env!);
                    const pkgList = requiredPackages.map(p => p.name).join(', ');
                    const allPkgNames = requiredPackages.map(p => p.name);
                    const installCmd = this.buildInstallSuggestion(requiredPackages, allPkgNames);
                    const warning = warnings.length > 0
                        ? `${warnings.join(' ')} Using poetry env '${env.name}'.`
                        : `Using '${env.name}' with required packages (${pkgList}). To use your configured environment, run: ${installCmd}`;
                    return { success: true, command: env.pythonPath, warning, environment: depCheck.env };
                }
            }
        } catch {
            // Poetry not available
        }

        // 7. Try pyenv environments
        try {
            const pyenvEnvs = await this.pyenvProvider.listEnvironments();
            for (const env of pyenvEnvs) {
                const depCheck = await testPythonWithDeps(env.pythonPath);
                if (depCheck.success) {
                    this.cachePythonResult(env.pythonPath, depCheck.env!);
                    const pkgList = requiredPackages.map(p => p.name).join(', ');
                    const allPkgNames = requiredPackages.map(p => p.name);
                    const installCmd = this.buildInstallSuggestion(requiredPackages, allPkgNames);
                    const warning = warnings.length > 0
                        ? `${warnings.join(' ')} Using pyenv env '${env.name}'.`
                        : `Using '${env.name}' with required packages (${pkgList}). To use your configured environment, run: ${installCmd}`;
                    return { success: true, command: env.pythonPath, warning, environment: depCheck.env };
                }
            }
        } catch {
            // pyenv not available
        }

        // 8. Try system Python
        const systemPython = await this.systemProvider.findPython();
        if (systemPython) {
            const depCheck = await testPythonWithDeps(systemPython);
            if (depCheck.success) {
                this.cachePythonResult(systemPython, depCheck.env!);
                const pkgList = requiredPackages.map(p => p.name).join(', ');
                const allPkgNames = requiredPackages.map(p => p.name);
                const installCmd = this.buildInstallSuggestion(requiredPackages, allPkgNames);
                const warning = warnings.length > 0
                    ? `${warnings.join(' ')} Using system Python.`
                    : `Using system Python with required packages (${pkgList}). To use your configured environment, run: ${installCmd}`;
                return { success: true, command: systemPython, warning, environment: depCheck.env };
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
        preferredEnvNames: string[],
        searchWorkspaceVenvs: boolean
    ): Promise<Array<NukeEnvironment & { missingPackages: string[]; score: number }>> {
        const matchingEnvs: Array<NukeEnvironment & { missingPackages: string[]; score: number }> = [];
        const allEnvsResult = await this.listEnvironments(searchWorkspaceVenvs);
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

    /**
     * Build an install command suggestion based on package metadata.
     * Separates conda-only packages (e.g. paraview) from pip-installable ones.
     * Respects per-package channels and global conda channel preferences.
     */
    private buildInstallSuggestion(packages: PackageDependency[], missingNames: string[]): string {
        const missing = packages.filter(p => missingNames.includes(p.name));
        const condaPkgs = missing.filter(p => p.condaOnly);
        const pipPkgs = missing.filter(p => !p.condaOnly).map(p => p.name);

        // Default channels from config, fallback to conda-forge
        const defaultChannels = this.config.condaChannels
            ? this.config.condaChannels.split(',').map(c => c.trim()).filter(Boolean)
            : ['conda-forge'];

        const parts: string[] = [];

        // Conda packages: group by their channels
        if (condaPkgs.length > 0) {
            const channelGroups = new Map<string, string[]>();
            for (const pkg of condaPkgs) {
                const channels = pkg.channels?.length ? pkg.channels : defaultChannels;
                const key = channels.join(',');
                const list = channelGroups.get(key) || [];
                list.push(pkg.name);
                channelGroups.set(key, list);
            }
            for (const [channelsKey, names] of channelGroups) {
                const channels = channelsKey.split(',');
                const channelArgs = channels.flatMap(c => ['-c', c]).join(' ');
                parts.push(`conda install ${channelArgs} ${names.join(' ')}`);
            }
        }

        // Pip packages
        if (pipPkgs.length > 0) {
            const indexArg = this.config.pipExtraIndexUrl
                ? `--extra-index-url ${this.config.pipExtraIndexUrl} `
                : '';
            parts.push(`pip install ${indexArg}${pipPkgs.join(' ')}`.trim());
        }

        if (parts.length === 0) {
            return '';
        }
        if (parts.length === 1) {
            return parts[0];
        }
        return parts.join(' and ');
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
                const env = await getPythonInfo(this.config.pythonPath, 'system');
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
            const condaEnvs = await this.condaProvider.listEnvironments();
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

        // Try system Python
        try {
            const systemEnvs = await this.systemProvider.listEnvironments();
            for (const env of systemEnvs) {
                if (!environments.find(e => e.pythonPath === env.pythonPath)) {
                    environments.push(env);
                }
            }
        } catch {
            // Not found
        }

        // Try workspace venvs
        if (searchWorkspace) {
            try {
                const venvs = await this.venvProvider.listEnvironments();
                for (const env of venvs) {
                    if (!environments.find(e => e.pythonPath === env.pythonPath)) {
                        environments.push(env);
                    }
                }
            } catch {
                // Ignore errors
            }
        }

        // Try poetry environments
        try {
            const poetryEnvs = await this.poetryProvider.listEnvironments();
            for (const env of poetryEnvs) {
                if (!environments.find(e => e.pythonPath === env.pythonPath)) {
                    environments.push(env);
                }
            }
        } catch {
            // Poetry not available
        }

        // Try pyenv environments
        try {
            const pyenvEnvs = await this.pyenvProvider.listEnvironments();
            for (const env of pyenvEnvs) {
                if (!environments.find(e => e.pythonPath === env.pythonPath)) {
                    environments.push(env);
                }
            }
        } catch {
            // pyenv not available
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

        // Mark deletable status on each environment
        for (const env of uniqueEnvs) {
            env.isDeletable = this.isUserCreatedEnv(env);
        }

        const sortedEnvs = uniqueEnvs.sort((a, b) => {
            if (a.isActive && !b.isActive) return -1;
            if (!a.isActive && b.isActive) return 1;
            return a.name.localeCompare(b.name);
        });

        const selected = sortedEnvs.find(e => e.isActive) || sortedEnvs[0];

        return { environments: sortedEnvs, selected };
    }

    private cachePythonResult(command: string, _env: NukeEnvironment): void {
        this.cachedPythonCommand = command;
    }

    async prepareCreateEnvironmentCommand(options: CreateEnvironmentOptions): Promise<CreateEnvironmentCommand> {
        const { type, name, pythonSpecifier, cwd: explicitCwd, channels, packages: extraPackages } = options;
        const os = await import('os');
        const path = await import('path');
        const fs = await import('fs');
        const isWindows = process.platform === 'win32';
        const homeDir = os.homedir();
        const workspaceRoot = explicitCwd || process.cwd();

        if (type === 'conda') {
            const best = await this.condaProvider.getResolver().getBestCommand();
            if (!best) {
                throw new Error('No conda or mamba installation found');
            }

            const prefix = path.join(homeDir, '.nuke-ide', 'envs', name);
            const pythonArg = pythonSpecifier ? `python=${pythonSpecifier}` : 'python';

            // Resolve channels: explicit > preference > default
            const condaChannels = channels?.length
                ? channels
                : this.config.condaChannels?.split(',').map(c => c.trim()).filter(Boolean)
                || ['conda-forge'];
            const channelArgs = condaChannels.flatMap(c => ['-c', c]);

            const pkgArgs = extraPackages && extraPackages.length > 0 ? extraPackages : [];
            const args = ['create', '--prefix', prefix, ...channelArgs, pythonArg, ...pkgArgs, '-y'];
            const command = `"${best.cmd}" ${args.join(' ')}`;
            const expectedPythonPath = path.join(prefix, isWindows ? 'python.exe' : 'bin/python');

            // Check if environment already exists
            const condaMetaPath = path.join(prefix, 'conda-meta');
            try {
                await fs.promises.access(condaMetaPath);
                throw new Error(`ALREADY_EXISTS: Environment '${name}' already exists at ${prefix}`);
            } catch (error) {
                const errMsg = String((error as Error)?.message || error);
                if (errMsg.includes('ALREADY_EXISTS')) {
                    throw error;
                }
                // Directory doesn't exist — safe to create
            }

            return { cwd: homeDir, command, expectedPythonPath };
        }

        if (type === 'venv') {
            const pythonCmd = pythonSpecifier || 'python3';
            const command = `"${pythonCmd}" -m venv "${name}"`;
            const expectedPythonPath = path.join(workspaceRoot, name, isWindows ? 'Scripts\\python.exe' : 'bin/python');

            // Check if venv already exists
            try {
                await fs.promises.access(expectedPythonPath);
                throw new Error(`ALREADY_EXISTS: Virtualenv '${name}' already exists in workspace`);
            } catch (error) {
                const errMsg = String((error as Error)?.message || error);
                if (errMsg.includes('ALREADY_EXISTS')) {
                    throw error;
                }
                // Venv doesn't exist — safe to create
            }

            return { cwd: workspaceRoot, command, expectedPythonPath };
        }

        throw new Error(`Unknown environment type: ${type}`);
    }

    async getCondaCommand(): Promise<{ cmd: string; type: 'conda' | 'mamba' } | undefined> {
        return this.condaProvider.getResolver().getBestCommand();
    }

    async deleteEnvironment(env: NukeEnvironment): Promise<{ success: boolean; error?: string }> {
        if (!this.isUserCreatedEnv(env)) {
            return { success: false, error: 'Only user-created environments can be deleted.' };
        }

        try {
            if (env.type === 'conda') {
                const best = await this.condaProvider.getResolver().getBestCommand();
                if (!best) {
                    return { success: false, error: 'No conda or mamba installation found.' };
                }
                const { execSync } = await import('child_process');
                execSync(`"${best.cmd}" env remove --prefix "${env.envPath}" -y`, {
                    encoding: 'utf-8',
                    timeout: 120000
                });
            } else if (env.type === 'venv' || env.type === 'virtualenv') {
                if (!env.envPath) {
                    return { success: false, error: 'No environment path available.' };
                }
                const fs = await import('fs');
                await fs.promises.rm(env.envPath, { recursive: true, force: true });
            } else {
                return { success: false, error: `Cannot delete ${env.type} environments.` };
            }

            this.clearCache();
            return { success: true };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    }

    private isUserCreatedEnv(env: NukeEnvironment): boolean {
        if (!env.envPath) {
            return false;
        }
        const os = require('os');
        const path = require('path');
        const homeDir = os.homedir();

        // Conda envs created by NukeIDE are in ~/.nuke-ide/envs/
        if (env.type === 'conda' && env.envPath.startsWith(path.join(homeDir, '.nuke-ide', 'envs'))) {
            return true;
        }

        // All venvs/virtualenvs are considered user-managed
        if (env.type === 'venv' || env.type === 'virtualenv') {
            return true;
        }

        return false;
    }

    async createEnvironment(options: CreateEnvironmentOptions): Promise<CreateEnvironmentResult> {
        const { type, name, pythonSpecifier, cwd: explicitCwd } = options;
        let output = '';

        if (type === 'conda') {
            const best = await this.condaProvider.getResolver().getBestCommand();
            if (!best) {
                return { success: false, error: 'No conda or mamba installation found' };
            }

            const os = await import('os');
            const path = await import('path');
            const isWindows = process.platform === 'win32';
            const prefix = path.join(os.homedir(), '.nuke-ide', 'envs', name);

            try {
                const { execSync } = await import('child_process');
                const pythonArg = pythonSpecifier ? `python=${pythonSpecifier}` : 'python';
                const args = ['create', '--prefix', prefix, pythonArg, '-y'];
                const result = execSync(`"${best.cmd}" ${args.join(' ')}`, {
                    encoding: 'utf-8',
                    timeout: 300000,
                    stdio: ['pipe', 'pipe', 'pipe']
                });
                output += result;
            } catch (error) {
                return { success: false, error: `Failed to create conda env: ${error}`, output };
            }

            const pythonPath = path.join(prefix, isWindows ? 'python.exe' : 'bin/python');
            try {
                const fs = await import('fs');
                await fs.promises.access(pythonPath);
                const env = await getPythonInfo(pythonPath, 'conda');
                if (env) {
                    env.name = name;
                    this.clearCache();
                    return { success: true, environment: env, output };
                }
            } catch {
                return { success: false, error: 'Conda env created but Python not found in it', output };
            }
        }

        if (type === 'venv') {
            const path = await import('path');
            const workspaceRoot = explicitCwd || process.cwd();
            const venvPath = path.join(workspaceRoot, name);
            const pythonCmd = pythonSpecifier || 'python3';

            try {
                const { execSync } = await import('child_process');
                const result = execSync(`"${pythonCmd}" -m venv "${venvPath}"`, {
                    encoding: 'utf-8',
                    timeout: 120000,
                    stdio: ['pipe', 'pipe', 'pipe']
                });
                output += result;
            } catch (error) {
                return { success: false, error: `Failed to create venv: ${error}`, output };
            }

            const isWindows = process.platform === 'win32';
            const pythonPath = path.join(venvPath, isWindows ? 'Scripts\\python.exe' : 'bin/python');
            try {
                const fs = await import('fs');
                await fs.promises.access(pythonPath);
                const env = await getPythonInfo(pythonPath, 'venv');
                if (env) {
                    env.name = `${name} (workspace)`;
                    this.clearCache();
                    return { success: true, environment: env, output };
                }
            } catch {
                return { success: false, error: 'Venv created but Python not found in it', output };
            }
        }

        return { success: false, error: `Unknown environment type: ${type}` };
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
