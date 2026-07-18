// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
// 1. Redistributions of source code must retain the above copyright notice,
//    this list of conditions and the following disclaimer.
//
// 2. Redistributions in binary form must reproduce the above copyright notice,
//    this list of conditions and the following disclaimer in the documentation
//    and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.
// SPDX-License-Identifier: BSD-2-Clause
// *****************************************************************************

/**
 * Nuke Core Backend Service Implementation
 *
 * Main facade service that exposes the Nuke Core backend API to the frontend via JSON-RPC.
 * Implements {@link NukeCoreBackendServiceInterface} by delegating operations to
 * specialized domain services:
 *
 * - {@link EnvironmentService} – Python environment detection, creation, and management
 * - {@link PackageService}     – Package installation command preparation
 * - {@link HealthService}      – Health checks, config validation, and diagnostics
 *
 * This class is bound as a singleton in the Inversify container via
 * {@link NukeCoreBackendModule} and wired to the JSON-RPC connection handler at
 * {@link NUKE_CORE_BACKEND_PATH}.
 *
 * @module nuke-core/node
 * @see {@link NukeCoreBackendServiceInterface}
 * @see {@link EnvironmentService}
 * @see {@link PackageService}
 * @see {@link HealthService}
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import {
    NukeCoreBackendServiceInterface,
    PythonConfig,
    NukeEnvironment,
    PythonDetectionResult,
    ListEnvironmentsResult,
    PackageDependency,
    DependencyCheckResult,
    PythonDetectionOptions,
    PackageInstallOptions,
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

    /**
     * Update the global Python configuration used by the extension.
     *
     * @param config - The new Python configuration (pythonPath, condaEnv, etc.)
     * @returns A promise that resolves when the configuration is persisted
     * @throws Never throws; invalid paths are handled gracefully downstream
     * @see {@link EnvironmentService.setConfig}
     */
    async setConfig(config: PythonConfig): Promise<void> {
        this.environmentService.setConfig(config);
        console.log(`[NukeCore] Config updated: pythonPath=${config.pythonPath}, condaEnv=${config.condaEnv}`);
    }

    /**
     * Retrieve the currently stored Python configuration.
     *
     * @returns A promise resolving to the active {@link PythonConfig}
     * @throws Never throws
     * @see {@link EnvironmentService.getConfig}
     */
    async getConfig(): Promise<PythonConfig> {
        return this.environmentService.getConfig();
    }

    /**
     * Detect a usable Python interpreter on the system.
     *
     * Tries the configured path first, then falls back to standard search
     * heuristics (conda, venv, system Python).
     *
     * @returns A promise resolving to a {@link PythonDetectionResult}
     * @throws Never throws; failures are reported via `success: false`
     * @see {@link EnvironmentService.detectPython}
     */
    async detectPython(): Promise<PythonDetectionResult> {
        return this.environmentService.detectPython();
    }

    /**
     * Get the effective Python command string for the current session.
     *
     * This may return a fallback interpreter if the configured one is unavailable.
     *
     * @returns A promise resolving to the Python executable path, or `undefined` if none found
     * @throws Never throws
     * @see {@link EnvironmentService.getPythonCommand}
     */
    async getPythonCommand(): Promise<string | undefined> {
        return this.environmentService.getPythonCommand();
    }

    /**
     * List available Python environments on the system.
     *
     * @param searchWorkspace - When `true`, also scan the current workspace for local environments (e.g. `.venv`)
     * @returns A promise resolving to a {@link ListEnvironmentsResult} containing discovered environments
     * @throws Never throws; errors are returned as an empty list
     * @see {@link EnvironmentService.listEnvironments}
     */
    async listEnvironments(searchWorkspace?: boolean): Promise<ListEnvironmentsResult> {
        return this.environmentService.listEnvironments(searchWorkspace);
    }

    /**
     * Detect Python and optionally verify that required packages are importable.
     *
     * @param options - Detection options including a list of required packages to check
     * @returns A promise resolving to a {@link PythonDetectionResult} augmented with `missingPackages`
     * @throws Never throws; failures are reported via `success: false`
     * @see {@link EnvironmentService.detectPythonWithRequirements}
     */
    async detectPythonWithRequirements(options: PythonDetectionOptions): Promise<PythonDetectionResult & { missingPackages?: string[] }> {
        return this.environmentService.detectPythonWithRequirements(options);
    }

    /**
     * Check whether the specified packages are installed in the target Python environment.
     *
     * @param packages - Array of {@link PackageDependency} entries to verify
     * @param pythonPath - Explicit Python executable to query; falls back to the active session Python if omitted
     * @returns A promise resolving to a {@link DependencyCheckResult} with version info, missing packages, and mismatches
     * @throws Never throws
     * @see {@link EnvironmentService.checkPackages}
     */
    async checkDependencies(packages: PackageDependency[], pythonPath?: string): Promise<DependencyCheckResult> {
        const targetPython = pythonPath || (await this.getPythonCommand()) || 'python';
        return this.environmentService.checkPackages(packages, targetPython);
    }

    /**
     * Perform a comprehensive health check of the Nuke Core environment.
     *
     * Evaluates configured Python, active Python, conda/mamba, uv, and optionally
     * verifies the presence of requested packages.
     *
     * @param packages - Optional list of {@link PackageDependency} to include in the check
     * @returns A promise resolving to a {@link HealthCheckResult}
     * @throws Never throws; individual check failures are captured as non-passing items
     * @see {@link HealthService.healthCheck}
     */
    async healthCheck(packages?: PackageDependency[]): Promise<HealthCheckResult> {
        return this.healthService.healthCheck(packages);
    }

    /**
     * Validate the current Python configuration for structural correctness.
     *
     * Checks that configured paths exist and are executable, and that conda
     * environments are reachable.
     *
     * @returns A promise resolving to a {@link ConfigValidationResult}
     * @throws Never throws
     * @see {@link HealthService.validateConfig}
     * @see {@link getConfig}
     */
    async validateConfig(): Promise<ConfigValidationResult> {
        const config = await this.getConfig();
        return this.healthService.validateConfig(config);
    }

    /**
     * Gather system and environment diagnostics for troubleshooting.
     *
     * @returns A promise resolving to a record of diagnostic key/value pairs (platform, envs, conda, uv, etc.)
     * @throws Never throws; individual diagnostic sections may be omitted on error
     * @see {@link HealthService.getDiagnostics}
     */
    async getDiagnostics(): Promise<Record<string, unknown>> {
        return this.healthService.getDiagnostics();
    }

    /**
     * Create a new Python environment (conda, venv, or virtualenv).
     *
     * @param options - {@link CreateEnvironmentOptions} specifying the environment type, name, and packages
     * @returns A promise resolving to a {@link CreateEnvironmentResult}
     * @throws Never throws; errors are reported via `success: false` and `error`
     * @see {@link EnvironmentService.createEnvironment}
     */
    async createEnvironment(options: CreateEnvironmentOptions): Promise<CreateEnvironmentResult> {
        return this.environmentService.createEnvironment(options);
    }

    /**
     * Build the shell command that would be executed to create an environment,
     * without actually running it.
     *
     * Useful for UIs that want to preview the command before confirmation.
     *
     * @param options - {@link CreateEnvironmentOptions} specifying the environment parameters
     * @returns A promise resolving to a {@link CreateEnvironmentCommand} containing the command string and CWD
     * @throws Never throws
     * @see {@link EnvironmentService.prepareCreateEnvironmentCommand}
     */
    async prepareCreateEnvironmentCommand(options: CreateEnvironmentOptions): Promise<CreateEnvironmentCommand> {
        return this.environmentService.prepareCreateEnvironmentCommand(options);
    }

    /**
     * Build the shell command that would be executed to install packages,
     * without actually running it.
     *
     * Chooses the best available installer (conda/mamba → uv → pip) based on
     * the requested options and system state.
     *
     * @param options - {@link PackageInstallOptions} specifying packages, channels, extra args, etc.
     * @returns A promise resolving to an object with `command` (the shell command) and `cwd` (working directory)
     * @throws Never throws
     * @see {@link PackageService.prepareInstallPackagesCommand}
     */
    async prepareInstallPackagesCommand(options: PackageInstallOptions): Promise<{ command: string; cwd: string }> {
        return this.packageService.prepareInstallPackagesCommand(options);
    }

    /**
     * Find the best available conda or mamba executable on the system.
     *
     * @returns A promise resolving to the command info, or `undefined` if neither is installed
     * @throws Never throws
     * @see {@link EnvironmentService.getCondaCommand}
     */
    async getCondaCommand(): Promise<{ cmd: string; type: 'conda' | 'mamba' } | undefined> {
        return this.environmentService.getCondaCommand();
    }

    /**
     * Delete an existing Python environment.
     *
     * @param env - The {@link NukeEnvironment} to remove
     * @returns A promise resolving to `{ success: true }` on success, or `{ success: false, error: string }` on failure
     * @throws Never throws; failures are reported via the result object
     * @see {@link EnvironmentService.deleteEnvironment}
     */
    async deleteEnvironment(env: NukeEnvironment): Promise<{ success: boolean; error?: string }> {
        return this.environmentService.deleteEnvironment(env);
    }
}
