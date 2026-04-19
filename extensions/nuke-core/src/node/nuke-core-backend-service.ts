// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl/epl-2.0.
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
 * Main backend service that delegates to specialized services.
 * 
 * @module nuke-core/node
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import {
    NukeCoreBackendServiceInterface,
    PythonConfig,
    PythonDetectionResult,
    ListEnvironmentsResult,
    PackageDependency,
    DependencyCheckResult,
    PythonDetectionOptions,
    PackageInstallOptions,
    PackageInstallResult,
    HealthCheckResult,
    ConfigValidationResult,
    CreateEnvironmentOptions,
    CreateEnvironmentResult,
    CreateEnvironmentCommand
} from '../common/nuke-core-protocol';
import { EnvironmentService, PackageService, HealthService } from './services';

@injectable()
export class NukeCoreBackendServiceImpl implements NukeCoreBackendServiceInterface {
    
    @inject(EnvironmentService)
    protected readonly environmentService: EnvironmentService;
    
    @inject(PackageService)
    protected readonly packageService: PackageService;
    
    @inject(HealthService)
    protected readonly healthService: HealthService;

    async setConfig(config: PythonConfig): Promise<void> {
        this.environmentService.setConfig(config);
        console.log(`[NukeCore] Config updated: pythonPath=${config.pythonPath}, condaEnv=${config.condaEnv}`);
    }

    async getConfig(): Promise<PythonConfig> {
        return this.environmentService.getConfig();
    }

    async detectPython(): Promise<PythonDetectionResult> {
        return this.environmentService.detectPython();
    }

    async getPythonCommand(): Promise<string | undefined> {
        return this.environmentService.getPythonCommand();
    }

    async listEnvironments(searchWorkspace?: boolean): Promise<ListEnvironmentsResult> {
        return this.environmentService.listEnvironments(searchWorkspace);
    }

    async detectPythonWithRequirements(
        options: PythonDetectionOptions
    ): Promise<PythonDetectionResult & { missingPackages?: string[] }> {
        return this.environmentService.detectPythonWithRequirements(options);
    }

    async checkDependencies(packages: PackageDependency[], pythonPath?: string): Promise<DependencyCheckResult> {
        const targetPython = pythonPath || await this.getPythonCommand() || 'python';
        return this.environmentService.checkPackages(packages, targetPython);
    }

    async installPackages(options: PackageInstallOptions): Promise<PackageInstallResult> {
        return this.packageService.installPackages(options);
    }

    async healthCheck(packages?: string[]): Promise<HealthCheckResult> {
        return this.healthService.healthCheck(packages);
    }

    async validateConfig(): Promise<ConfigValidationResult> {
        const config = await this.getConfig();
        return this.healthService.validateConfig(config);
    }

    async getDiagnostics(): Promise<Record<string, unknown>> {
        return this.healthService.getDiagnostics();
    }

    async createEnvironment(options: CreateEnvironmentOptions): Promise<CreateEnvironmentResult> {
        return this.environmentService.createEnvironment(options);
    }

    async prepareCreateEnvironmentCommand(options: CreateEnvironmentOptions): Promise<CreateEnvironmentCommand> {
        return this.environmentService.prepareCreateEnvironmentCommand(options);
    }

    async prepareInstallPackagesCommand(options: PackageInstallOptions): Promise<{ command: string; cwd: string }> {
        return this.packageService.prepareInstallPackagesCommand(options);
    }

    async getCondaCommand(): Promise<{ cmd: string; type: 'conda' | 'mamba' } | undefined> {
        return this.environmentService.getCondaCommand();
    }
}
