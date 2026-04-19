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
 * OpenMC Health Check Service
 * 
 * Provides comprehensive health checks for OpenMC setup.
 * 
 * @module openmc-studio/browser
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { NukeCoreService } from 'nuke-core/lib/common';
import { OpenMCEnvironmentService } from './openmc-environment-service';

export interface HealthCheckIssue {
    severity: 'error' | 'warning' | 'info';
    category: 'environment' | 'openmc' | 'cross-sections' | 'chain-file' | 'mpi' | 'dagmc';
    message: string;
    suggestion?: string;
    autoFixable?: boolean;
}

export interface HealthCheckResult {
    healthy: boolean;
    ready: boolean;
    issues: HealthCheckIssue[];
    summary: {
        errors: number;
        warnings: number;
        info: number;
    };
    environment?: {
        name: string;
        version?: string;
        pythonCommand: string;
    };
}

@injectable()
export class OpenMCHealthService {
    
    @inject(NukeCoreService)
    protected readonly nukeCore: NukeCoreService;
    
    @inject(OpenMCEnvironmentService)
    protected readonly envService: OpenMCEnvironmentService;

    /**
     * Run comprehensive health check.
     */
    async runHealthCheck(): Promise<HealthCheckResult> {
        const issues: HealthCheckIssue[] = [];
        
        // Check 1: Environment availability
        const envStatus = await this.checkEnvironment();
        issues.push(...envStatus.issues);
        
        if (!envStatus.available) {
            // Can't proceed without environment
            return this.createResult(issues, undefined);
        }

        // Check 2: OpenMC package
        const openmcStatus = await this.checkOpenMC(envStatus.pythonCommand!);
        issues.push(...openmcStatus.issues);

        // Check 3: Cross-sections
        const xsStatus = await this.checkCrossSections();
        issues.push(...xsStatus.issues);

        // Check 4: Chain file (optional)
        const chainStatus = await this.checkChainFile();
        issues.push(...chainStatus.issues);

        // Check 5: MPI support
        const mpiStatus = await this.checkMPI(envStatus.pythonCommand!);
        issues.push(...mpiStatus.issues);

        // Check 6: DAGMC support
        const dagmcStatus = await this.checkDAGMC(envStatus.pythonCommand!);
        issues.push(...dagmcStatus.issues);

        return this.createResult(issues, {
            name: envStatus.environment!.name,
            version: openmcStatus.version,
            pythonCommand: envStatus.pythonCommand!
        });
    }

    /**
     * Quick check if OpenMC is ready to run.
     */
    async isReady(): Promise<boolean> {
        const result = await this.runHealthCheck();
        return result.ready;
    }

    /**
     * Get a human-readable status summary.
     */
    getStatusMessage(result: HealthCheckResult): string {
        if (result.ready) {
            return `OpenMC ready (${result.environment?.name}${result.environment?.version ? ' ' + result.environment.version : ''})`;
        }
        const errors = result.issues.filter(i => i.severity === 'error');
        if (errors.length > 0) {
            return errors[0].message;
        }
        return 'OpenMC not configured';
    }

    // -------------------------------------------------------------------------
    // Individual Check Methods
    // -------------------------------------------------------------------------

    private async checkEnvironment(): Promise<{
        available: boolean;
        issues: HealthCheckIssue[];
        pythonCommand?: string;
        environment?: { name: string; version?: string };
    }> {
        const issues: HealthCheckIssue[] = [];

        const env = await this.nukeCore.getSelectedEnvironment();
        if (!env) {
            issues.push({
                severity: 'error',
                category: 'environment',
                message: 'No Python environment configured',
                suggestion: 'Configure Python in Settings → Nuke Utils, or install OpenMC',
                autoFixable: false
            });
            return { available: false, issues };
        }

        // Check OpenMC in the configured env only (no fallback discovery)
        const depCheck = await this.nukeCore.checkDependencies(
            [{ name: 'openmc' }],
            env.pythonPath
        );

        if (!depCheck.available) {
            issues.push({
                severity: 'error',
                category: 'environment',
                message: `Configured environment '${env.name}' does not have OpenMC`,
                suggestion: 'Install OpenMC or switch to an environment with OpenMC',
                autoFixable: true
            });
            return { available: false, issues };
        }

        return {
            available: true,
            issues,
            pythonCommand: env.pythonPath,
            environment: env
        };
    }

    private async checkOpenMC(pythonCommand: string): Promise<{
        issues: HealthCheckIssue[];
        version?: string
    }> {
        const issues: HealthCheckIssue[] = [];

        try {
            const depCheck = await this.nukeCore.checkDependencies(
                [{ name: 'openmc', required: true }],
                pythonCommand
            );

            if (!depCheck.available) {
                issues.push({
                    severity: 'error',
                    category: 'openmc',
                    message: 'OpenMC package not found',
                    autoFixable: true
                });
            } else {
                const version = depCheck.versions['openmc'];
                return { issues, version };
            }
        } catch (error) {
            issues.push({
                severity: 'error',
                category: 'openmc',
                message: `Failed to check OpenMC: ${error}`
            });
        }

        return { issues };
    }

    private async checkCrossSections(): Promise<{ issues: HealthCheckIssue[] }> {
        const issues: HealthCheckIssue[] = [];
        const xsPath = this.nukeCore.getCrossSectionsPath();

        if (!xsPath) {
            issues.push({
                severity: 'warning',
                category: 'cross-sections',
                message: 'Cross-sections path not set',
                suggestion: 'Set OPENMC_CROSS_SECTIONS environment variable or configure in Settings → Nuke Utils',
                autoFixable: false
            });
        }

        return { issues };
    }

    private async checkChainFile(): Promise<{ issues: HealthCheckIssue[] }> {
        const issues: HealthCheckIssue[] = [];
        const chainPath = this.nukeCore.getChainFilePath();

        if (!chainPath) {
            issues.push({
                severity: 'info',
                category: 'chain-file',
                message: 'Chain file not set (only needed for depletion)',
                suggestion: 'Set OPENMC_CHAIN_FILE to enable depletion calculations'
            });
        }

        return { issues };
    }

    private async checkMPI(pythonCommand: string): Promise<{ issues: HealthCheckIssue[] }> {
        const issues: HealthCheckIssue[] = [];

        try {
            const depCheck = await this.nukeCore.checkDependencies(
                [{ name: 'mpi4py', required: false }],
                pythonCommand
            );

            if (!depCheck.available) {
                issues.push({
                    severity: 'info',
                    category: 'mpi',
                    message: 'MPI support not available (mpi4py not installed)'
                });
            }
        } catch {
            // MPI check failed silently
        }

        return { issues };
    }

    private async checkDAGMC(pythonCommand: string): Promise<{ issues: HealthCheckIssue[] }> {
        const issues: HealthCheckIssue[] = [];
        
        try {
            const depCheck = await this.nukeCore.checkDependencies(
                [{ name: 'pydagmc', required: false }, { name: 'pymoab', required: false }],
                pythonCommand
            );

            if (!depCheck.available) {
                issues.push({
                    severity: 'info',
                    category: 'dagmc',
                    message: 'DAGMC support not available',
                    suggestion: 'Install pymoab and pydagmc for CAD geometry support'
                });
            }
        } catch {
            // DAGMC check failed silently
        }

        return { issues };
    }

    // -------------------------------------------------------------------------
    // Helper Methods
    // -------------------------------------------------------------------------

    private createResult(
        issues: HealthCheckIssue[],
        environment?: { name: string; version?: string; pythonCommand: string }
    ): HealthCheckResult {
        const errors = issues.filter(i => i.severity === 'error').length;
        const warnings = issues.filter(i => i.severity === 'warning').length;
        const info = issues.filter(i => i.severity === 'info').length;

        // Ready if no errors and environment is available
        const ready = errors === 0 && !!environment;

        return {
            healthy: ready && warnings === 0,
            ready,
            issues,
            summary: { errors, warnings, info },
            environment
        };
    }
}
