// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

/**
 * Health Service
 *
 * Handles health checks and diagnostics.
 *
 * @module nuke-core/node
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import {
    PythonConfig,
    HealthCheckResult,
    HealthCheckItem,
    ConfigValidationResult,
    ConfigValidationError,
    ConfigValidationWarning,
    PackageDependency
} from '../../common/nuke-core-protocol';
import { EnvironmentService } from './environment/environment-service';
import { CondaResolver } from './environment/utils/conda-resolver';
import { UvResolver } from './environment/utils/uv-resolver';

@injectable()
export class HealthService {

    @inject(EnvironmentService)
    protected readonly environmentService: EnvironmentService;

    private readonly condaResolver = new CondaResolver();
    private readonly uvResolver = new UvResolver();

    private buildInstallSuggestion(pkg: PackageDependency): string {
        if (pkg.installCommand) {
            return pkg.installCommand;
        }
        if (pkg.condaOnly) {
            const channels = pkg.channels?.length
                ? pkg.channels.map(c => `-c ${c}`).join(' ')
                : '-c conda-forge';
            return `conda install ${channels} ${pkg.name}`;
        }
        if (pkg.extraIndexUrl) {
            return `pip install --extra-index-url ${pkg.extraIndexUrl} ${pkg.name}`;
        }
        return `pip install ${pkg.name}`;
    }

    async healthCheck(packages?: PackageDependency[]): Promise<HealthCheckResult> {
        const checks: HealthCheckItem[] = [];

        // Check configured Python availability (does not include fallbacks)
        const configuredPython = await this.environmentService.getConfiguredPythonCommand();
        if (configuredPython) {
            checks.push({
                name: 'Configured Python Environment',
                passed: true,
                message: `Python available at ${configuredPython}`,
                severity: undefined
            });
        } else {
            const config = this.environmentService.getConfig();
            const hasConfig = !!(config.pythonPath || config.condaEnv);
            checks.push({
                name: 'Configured Python Environment',
                passed: false,
                message: hasConfig
                    ? `Configured Python not found (${config.pythonPath || config.condaEnv})`
                    : 'No Python environment configured',
                severity: 'error',
                suggestion: hasConfig
                    ? 'Check that the configured path or conda environment exists'
                    : 'Configure nuke.pythonPath or nuke.condaEnv in settings'
            });
        }

        // Check active Python (may be a fallback)
        try {
            const activePython = await this.environmentService.getPythonCommand();
            if (activePython && activePython !== configuredPython) {
                checks.push({
                    name: 'Active Python Environment',
                    passed: true,
                    message: `Using fallback Python at ${activePython}`,
                    severity: 'warning',
                    suggestion: 'Install missing packages into your configured environment to use it'
                });
            }
        } catch {
            // Ignore — configured Python check already covers the error case
        }

        // Check conda/mamba availability
        try {
            const best = await this.condaResolver.getBestCommand();
            if (best) {
                checks.push({
                    name: 'Conda/Mamba',
                    passed: true,
                    message: `${best.type} available at ${best.cmd}`,
                    severity: undefined
                });
            } else {
                checks.push({
                    name: 'Conda/Mamba',
                    passed: false,
                    message: 'No conda or mamba installation found',
                    severity: 'warning',
                    suggestion: 'Install Miniforge3 for the best experience with nuclear engineering packages'
                });
            }
        } catch (error) {
            checks.push({
                name: 'Conda/Mamba',
                passed: false,
                message: `Error checking conda/mamba: ${error}`,
                severity: 'warning'
            });
        }

        // Check uv availability
        try {
            const uv = await this.uvResolver.findUvExe();
            if (uv) {
                const version = await this.uvResolver.getVersion();
                checks.push({
                    name: 'UV',
                    passed: true,
                    message: version ? `UV available: ${version}` : 'UV available',
                    severity: undefined
                });
            } else {
                checks.push({
                    name: 'UV',
                    passed: false,
                    message: 'UV not found',
                    severity: 'warning',
                    suggestion: 'Install UV for much faster package installations: https://github.com/astral-sh/uv'
                });
            }
        } catch (error) {
            checks.push({
                name: 'UV',
                passed: false,
                message: `Error checking UV: ${error}`,
                severity: 'warning'
            });
        }

        // Check specific packages in the configured environment (not fallback)
        if (packages && packages.length > 0) {
            if (configuredPython) {
                const checkResult = await this.environmentService.checkPackages(packages, configuredPython);
                for (const pkg of packages) {
                    const version = checkResult.versions[pkg.name];
                    const isMissing = checkResult.missing.includes(pkg.name);
                    const mismatch = checkResult.versionMismatches.find(v => v.name === pkg.name);

                    if (mismatch) {
                        checks.push({
                            name: `Package: ${pkg.name}`,
                            passed: false,
                            message: `${pkg.name} ${mismatch.found} < required ${mismatch.required}`,
                            severity: pkg.required !== false ? 'error' : 'warning',
                            suggestion: this.buildInstallSuggestion(pkg)
                        });
                    } else if (isMissing) {
                        checks.push({
                            name: `Package: ${pkg.name}`,
                            passed: false,
                            message: `${pkg.name} is not installed`,
                            severity: pkg.required !== false ? 'error' : 'warning',
                            suggestion: this.buildInstallSuggestion(pkg)
                        });
                    } else if (version) {
                        checks.push({
                            name: `Package: ${pkg.name}`,
                            passed: true,
                            message: version === 'installed (version unknown)'
                                ? `${pkg.name} is available`
                                : `${pkg.name} ${version}`,
                            severity: undefined
                        });
                    } else {
                        // Optional package missing — show for completeness
                        checks.push({
                            name: `Package: ${pkg.name}`,
                            passed: false,
                            message: `${pkg.name} is not installed (optional)`,
                            severity: 'warning',
                            suggestion: this.buildInstallSuggestion(pkg)
                        });
                    }
                }
            } else {
                for (const pkg of packages) {
                    checks.push({
                        name: `Package: ${pkg.name}`,
                        passed: false,
                        message: `${pkg.name} cannot be checked — no configured Python`,
                        severity: pkg.required !== false ? 'error' : 'warning',
                        suggestion: this.buildInstallSuggestion(pkg)
                    });
                }
            }
        }

        const healthy = checks.every(c => c.passed || c.severity !== 'error');

        return { healthy, checks };
    }

    async validateConfig(config: PythonConfig): Promise<ConfigValidationResult> {
        const errors: ConfigValidationError[] = [];
        const warnings: ConfigValidationWarning[] = [];

        // Validate Python path if set
        if (config.pythonPath) {
            const fs = await import('fs');
            if (!fs.existsSync(config.pythonPath)) {
                errors.push({
                    field: 'pythonPath',
                    message: 'Python path does not exist',
                    value: config.pythonPath
                });
            } else {
                try {
                    const { execSync } = await import('child_process');
                    execSync(`"${config.pythonPath}" --version`, { stdio: 'ignore' });
                } catch {
                    errors.push({
                        field: 'pythonPath',
                        message: 'Path exists but is not a valid Python executable',
                        value: config.pythonPath
                    });
                }
            }
        }

        // Validate conda environment if set
        if (config.condaEnv) {
            const best = await this.condaResolver.getBestCommand();
            if (!best) {
                warnings.push({
                    field: 'condaEnv',
                    message: 'No conda or mamba installation found on the system',
                    value: config.condaEnv
                });
            } else {
                try {
                    const { execSync } = await import('child_process');
                    execSync(`${best.cmd} env list --json`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
                    // We could parse the JSON and check if the env exists, but running the command
                    // successfully at least means conda/mamba is functional.
                } catch {
                    warnings.push({
                        field: 'condaEnv',
                        message: `Unable to validate conda environment '${config.condaEnv}' — conda/mamba may be misconfigured`,
                        value: config.condaEnv
                    });
                }
            }
        }

        return { valid: errors.length === 0, errors, warnings };
    }

    async getDiagnostics(): Promise<Record<string, unknown>> {
        const diagnostics: Record<string, unknown> = {};

        // Platform info
        diagnostics.platform = {
            os: process.platform,
            arch: process.arch,
            nodeVersion: process.version
        };

        // Environment info
        try {
            const envResult = await this.environmentService.detectPython();
            diagnostics.environment = {
                detected: envResult.success,
                command: envResult.command,
                error: envResult.error
            };

            if (envResult.environment) {
                diagnostics.environmentDetails = envResult.environment;
            }
        } catch (error) {
            diagnostics.environmentError = String(error);
        }

        // List all environments
        try {
            const envs = await this.environmentService.listEnvironments(true);
            diagnostics.environments = {
                count: envs.environments.length,
                selected: envs.selected?.name
            };
        } catch (error) {
            diagnostics.environmentsError = String(error);
        }

        // Conda/mamba info
        try {
            const best = await this.condaResolver.getBestCommand();
            const installations = await this.condaResolver.findInstallations();
            diagnostics.conda = {
                bestCommand: best,
                installations: installations.map(i => ({
                    rootPath: i.rootPath,
                    type: i.type,
                    hasConda: !!i.condaExe,
                    hasMamba: !!i.mambaExe
                }))
            };
        } catch (error) {
            diagnostics.condaError = String(error);
        }

        // UV info
        try {
            const uv = await this.uvResolver.findUvExe();
            diagnostics.uv = {
                available: !!uv,
                path: uv,
                version: uv ? await this.uvResolver.getVersion() : undefined
            };
        } catch (error) {
            diagnostics.uvError = String(error);
        }

        // Environment variables
        diagnostics.envVars = {
            CONDA_PREFIX: process.env.CONDA_PREFIX,
            CONDA_EXE: process.env.CONDA_EXE,
            MAMBA_EXE: process.env.MAMBA_EXE,
            VIRTUAL_ENV: process.env.VIRTUAL_ENV,
            PYTHONPATH: process.env.PYTHONPATH,
            PATH: process.env.PATH?.split(process.platform === 'win32' ? ';' : ':').slice(0, 5)
        };

        return diagnostics;
    }
}
