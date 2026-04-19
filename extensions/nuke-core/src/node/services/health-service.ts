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
    ConfigValidationWarning
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

    async healthCheck(packages?: string[]): Promise<HealthCheckResult> {
        const checks: HealthCheckItem[] = [];

        // Check Python availability
        try {
            const pythonCommand = await this.environmentService.getPythonCommand();
            if (pythonCommand) {
                checks.push({
                    name: 'Python Environment',
                    passed: true,
                    message: `Python available at ${pythonCommand}`,
                    severity: undefined
                });
            } else {
                checks.push({
                    name: 'Python Environment',
                    passed: false,
                    message: 'Python not found',
                    severity: 'error',
                    suggestion: 'Configure nuke.pythonPath or nuke.condaEnv in settings'
                });
            }
        } catch (error) {
            checks.push({
                name: 'Python Environment',
                passed: false,
                message: `Error checking Python: ${error}`,
                severity: 'error'
            });
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

        // Check specific packages if requested
        if (packages && packages.length > 0) {
            const pythonCommand = await this.environmentService.getPythonCommand();
            if (pythonCommand) {
                for (const pkg of packages) {
                    try {
                        const { execSync } = await import('child_process');
                        execSync(`"${pythonCommand}" -c "import ${pkg}"`, { stdio: 'ignore' });
                        checks.push({
                            name: `Package: ${pkg}`,
                            passed: true,
                            message: `${pkg} is available`,
                            severity: undefined
                        });
                    } catch {
                        checks.push({
                            name: `Package: ${pkg}`,
                            passed: false,
                            message: `${pkg} is not installed`,
                            severity: 'warning',
                            suggestion: `Install ${pkg} with: pip install ${pkg}`
                        });
                    }
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
