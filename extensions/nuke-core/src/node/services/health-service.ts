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
import { EnvironmentService } from './environment-service';

@injectable()
export class HealthService {
    
    @inject(EnvironmentService)
    protected readonly environmentService: EnvironmentService;

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
            try {
                const { execSync } = await import('child_process');
                execSync(`conda env list | grep ${config.condaEnv}`, { stdio: 'ignore' });
            } catch {
                warnings.push({
                    field: 'condaEnv',
                    message: `Conda environment '${config.condaEnv}' not found in conda`,
                    value: config.condaEnv
                });
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
        
        // Environment variables
        diagnostics.envVars = {
            CONDA_PREFIX: process.env.CONDA_PREFIX,
            VIRTUAL_ENV: process.env.VIRTUAL_ENV,
            PYTHONPATH: process.env.PYTHONPATH,
            PATH: process.env.PATH?.split(':').slice(0, 5)
        };
        
        return diagnostics;
    }
}
