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
 * Nuke Core Frontend Service
 *
 * Provides core infrastructure services for all NukeIDE extensions:
 * - Environment management (Python/Conda)
 * - Configuration management
 * - Package management
 * - Health checks
 * - Shared utilities
 *
 * DI bindings:
 * - `NukeCoreBackendService` – backend RPC proxy
 * - `PreferenceService` – Theia preference access
 * - `NukeCoreStatusBarVisibility` – visibility coordination
 *
 * @module nuke-core/browser
 */

import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core/lib/common';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import {
    NukeCoreBackendService,
    NukeCoreBackendServiceInterface,
    PythonConfig,
    NukeEnvironment,
    PythonDetectionResult,
    NukeEnvironmentChangedEvent,
    EnvironmentFallbackEvent,
    PackageDependency,
    DependencyCheckResult,
    PythonDetectionOptions,
    PackageInstallOptions,
    HealthCheckResult,
    ConfigValidationResult,
    EnvironmentStatus,
    NukeCoreStatusBarVisibility,
    CreateEnvironmentOptions,
    CreateEnvironmentResult,
    CreateEnvironmentCommand
} from '../../common/nuke-core-protocol';
import { NukeCoreVisibilityService } from './nuke-core-visibility-service';

/**
 * Central frontend service for Nuke Core operations.
 *
 * Orchestrates Python environment detection, configuration, package management,
 * and health checks. Exposes events so UI components (status bar, widgets) can
 * react to environment changes.
 *
 * @see {@link NukeCoreVisibilityService}
 * @see {@link EnvironmentActionsHelper}
 */
@injectable()
export class NukeCoreService {
    @inject(NukeCoreBackendService)
    protected readonly backend: NukeCoreBackendServiceInterface;

    @inject(PreferenceService)
    protected readonly preferences: PreferenceService;

    @inject(NukeCoreStatusBarVisibility)
    protected readonly visibilityService: NukeCoreVisibilityService;

    private currentConfig: PythonConfig = {};
    private currentEnvironment?: NukeEnvironment;
    private lastFallbackEnv?: NukeEnvironment;

    /** Emitted whenever the active Python environment changes. */
    private readonly _onEnvironmentChanged = new Emitter<NukeEnvironmentChangedEvent>();
    readonly onEnvironmentChanged: Event<NukeEnvironmentChangedEvent> = this._onEnvironmentChanged.event;

    /** Emitted whenever the environment status object changes. */
    private readonly _onStatusChanged = new Emitter<EnvironmentStatus>();
    readonly onStatusChanged: Event<EnvironmentStatus> = this._onStatusChanged.event;

    /**
     * Event fired when Python environment detection falls back to a different environment.
     * Useful for showing warnings to users when their configured environment doesn't have required packages.
     *
     * Example usage:
     * ```typescript
     * nukeCore.onEnvironmentFallback(event => {
     *     messageService.warn(`Using fallback environment: ${event.fallbackEnv.name}`);
     * });
     * ```
     *
     * @see {@link detectPythonWithRequirements}
     */
    private readonly _onEnvironmentFallback = new Emitter<EnvironmentFallbackEvent>();
    readonly onEnvironmentFallback: Event<EnvironmentFallbackEvent> = this._onEnvironmentFallback.event;

    @postConstruct()
    protected init(): void {
        console.log('[NukeCore] Service initialized');

        // Sync from preferences initially, then adopt the backend-suggested
        // default environment (e.g. $NUKE_DIR inside NukeLab container
        // images) when the user has not configured one.
        this.syncFromPreferences().then(() => this.applySuggestedConfigIfUnconfigured());

        // Listen for preference changes
        this.preferences.onPreferenceChanged((event) => {
            if (event.preferenceName.startsWith('nuke.')) {
                console.log('[NukeCore] Preference changed:', event.preferenceName);
                // Use setTimeout to ensure the preference has been fully processed
                setTimeout(() => this.syncFromPreferences(), 0);
            }
        });
    }

    /**
     * Apply the backend-suggested default configuration when the user has not
     * configured a Python environment via the nuke.* preferences.
     * Session-scoped only: preferences are not modified, so an explicit user
     * setting always wins on the next startup.
     */
    protected async applySuggestedConfigIfUnconfigured(): Promise<void> {
        try {
            if (this.isConfigured()) {
                return;
            }
            const suggested = await this.backend.getSuggestedConfig();
            if (suggested.pythonPath || suggested.condaEnv) {
                console.log(`[NukeCore] Applying suggested default environment: ${suggested.pythonPath || suggested.condaEnv}`);
                await this.setConfig(suggested);
            }
        } catch (e) {
            console.warn('[NukeCore] Failed to apply suggested default configuration:', e);
        }
    }

    /**
     * Sync configuration from nuke.* preferences.
     * Handles the case where workspace scope returns empty string overriding user settings.
     */
    protected async syncFromPreferences(): Promise<void> {
        await this.doSyncFromPreferences();
    }

    protected async doSyncFromPreferences(): Promise<void> {
        const inspectPath = this.preferences.inspect<string>('nuke.pythonPath');
        const inspectEnv = this.preferences.inspect<string>('nuke.condaEnv');
        const inspectChannels = this.preferences.inspect<string>('nuke.condaChannels');
        const inspectIndex = this.preferences.inspect<string>('nuke.pipExtraIndexUrl');

        let pythonPath: string | undefined;
        let condaEnv: string | undefined;
        let condaChannels: string | undefined;
        let pipExtraIndexUrl: string | undefined;

        // Only use values if they are explicitly set (non-empty)
        // Priority: workspaceFolderValue > workspaceValue > globalValue (user)
        // This avoids the Theia scope merge bug where empty workspace overrides user settings
        const pickValue = (
            inspect: { workspaceFolderValue?: unknown; workspaceValue?: unknown; globalValue?: unknown } | undefined
        ): string | undefined => {
            if (inspect?.workspaceFolderValue?.toString().trim()) {
                return inspect.workspaceFolderValue as string;
            } else if (inspect?.workspaceValue?.toString().trim()) {
                return inspect.workspaceValue as string;
            } else if (inspect?.globalValue?.toString().trim()) {
                return inspect.globalValue as string;
            }
            return undefined;
        };

        pythonPath = pickValue(inspectPath);
        condaEnv = pickValue(inspectEnv);
        condaChannels = pickValue(inspectChannels);
        pipExtraIndexUrl = pickValue(inspectIndex);

        // CRITICAL: If preferences are empty but we already have a valid config, DON'T OVERWRITE IT
        // This handles the case where workspace scope returns "" while user scope has the real value
        // We only allow clearing if explicitly set to empty, not from scope merge issues
        const hasExistingConfig = this.currentConfig.pythonPath || this.currentConfig.condaEnv;
        const hasNewPrefs = pythonPath || condaEnv;

        if (!hasNewPrefs && hasExistingConfig) {
            return;
        }

        // Also skip if values haven't changed
        if (
            pythonPath === this.currentConfig.pythonPath &&
            condaEnv === this.currentConfig.condaEnv &&
            condaChannels === this.currentConfig.condaChannels &&
            pipExtraIndexUrl === this.currentConfig.pipExtraIndexUrl
        ) {
            return;
        }

        const newConfig: PythonConfig = {
            pythonPath: pythonPath || undefined,
            condaEnv: condaEnv || undefined,
            condaChannels: condaChannels || undefined,
            pipExtraIndexUrl: pipExtraIndexUrl || undefined
        };

        await this.setConfig(newConfig);
    }

    /**
     * Check if Nuke Core is properly configured.
     * Returns false if Python path or conda env is not set.
     * Uses internal currentConfig to avoid Theia preference scope merging issues.
     *
     * @returns `true` when either `pythonPath` or `condaEnv` is configured.
     */
    isConfigured(): boolean {
        return !!(this.currentConfig.pythonPath || this.currentConfig.condaEnv);
    }

    /**
     * Get configuration error message if not configured.
     *
     * @returns A human-readable error string, or `undefined` when configured.
     */
    getConfigError(): string | undefined {
        if (this.isConfigured()) {
            return undefined;
        }
        return 'Nuke is not configured. Please set environment in Settings → Nuke Utils.';
    }

    /**
     * Set environment configuration.
     * Only emits onEnvironmentChanged when the config actually changes
     * from a previously established state (not on initial load).
     *
     * @param config - The new Python/Conda configuration.
     * @returns Resolves when the backend has persisted the config.
     */
    async setConfig(config: PythonConfig): Promise<void> {
        const previous = { ...this.currentConfig };
        const previousEnv = this.currentEnvironment;

        // Skip if config hasn't actually changed
        if (
            previous.pythonPath === config.pythonPath &&
            previous.condaEnv === config.condaEnv &&
            previous.condaChannels === config.condaChannels &&
            previous.pipExtraIndexUrl === config.pipExtraIndexUrl
        ) {
            return;
        }

        this.currentConfig = { ...config };
        await this.backend.setConfig(config);

        // Clear fallback when config changes
        this.lastFallbackEnv = undefined;

        // Update current environment info
        await this.updateCurrentEnvironment();

        // Only emit if there was a previously configured environment.
        // Skip on initial load when previous was empty.
        const hadPreviousConfig = !!(previous.pythonPath || previous.condaEnv);
        if (hadPreviousConfig) {
            this._onEnvironmentChanged.fire({
                previous,
                current: config,
                previousEnv,
                currentEnv: this.currentEnvironment
            });
        }

        this.emitStatus();
    }

    /**
     * Get current Python configuration.
     *
     * @returns The configuration held by the backend.
     */
    async getConfig(): Promise<PythonConfig> {
        return this.backend.getConfig();
    }

    /**
     * Get the Python command to use (cached).
     *
     * @returns Absolute path to the Python executable, or `undefined`.
     */
    async getPythonCommand(): Promise<string | undefined> {
        return this.backend.getPythonCommand();
    }

    /**
     * Detect Python command based on current config.
     *
     * @returns Detection result including the resolved environment.
     */
    async detectPython(): Promise<PythonDetectionResult> {
        const result = await this.backend.detectPython();
        if (result.environment) {
            this.currentEnvironment = result.environment;
            this.emitStatus();
        }
        return result;
    }

    /**
     * List available Python environments.
     *
     * @param searchWorkspace - Also search for venvs in workspace.
     * @returns Array of discovered environments.
     */
    async listEnvironments(searchWorkspace = false): Promise<NukeEnvironment[]> {
        const result = await this.backend.listEnvironments(searchWorkspace);
        return result.environments;
    }

    /**
     * Get the currently selected environment.
     *
     * @returns The environment marked as selected, or `undefined`.
     */
    async getSelectedEnvironment(): Promise<NukeEnvironment | undefined> {
        const result = await this.backend.listEnvironments();
        return result.selected;
    }

    /**
     * Switch to a specific environment.
     * Updates preferences accordingly.
     *
     * @param env - The target environment.
     * @returns Resolves after preferences have been updated.
     */
    async switchToEnvironment(env: NukeEnvironment): Promise<void> {
        if (env.type === 'conda') {
            await this.preferences.set('nuke.condaEnv', env.name);
            await this.preferences.set('nuke.pythonPath', '');
        } else {
            await this.preferences.set('nuke.pythonPath', env.pythonPath);
            await this.preferences.set('nuke.condaEnv', '');
        }
        // syncFromPreferences will be triggered by preference change
    }

    /**
     * Check package dependencies.
     *
     * @param packages - Packages to verify.
     * @param pythonPath - Optional explicit Python path; falls back to configured path.
     * @returns Availability result and list of missing packages.
     */
    async checkDependencies(packages: PackageDependency[], pythonPath?: string): Promise<DependencyCheckResult> {
        return this.backend.checkDependencies(packages, pythonPath);
    }

    /**
     * Detect Python with specific package requirements.
     * Emits onEnvironmentFallback if a fallback to a different environment occurs.
     *
     * Note: This does NOT update currentEnvironment when a fallback occurs.
     * The status bar should show the configured environment, not a fallback.
     *
     * @param options - Detection options including required packages.
     * @returns Detection result with optional missing packages and warning message.
     * @see {@link onEnvironmentFallback}
     */
    async detectPythonWithRequirements(options: PythonDetectionOptions): Promise<PythonDetectionResult & { missingPackages?: string[] }> {
        const requestedEnv = this.currentConfig.condaEnv || this.currentConfig.pythonPath;
        const result = await this.backend.detectPythonWithRequirements(options);

        if (result.environment) {
            // Check if result is a fallback (different from what was requested)
            const isFallback = requestedEnv && result.environment.name !== requestedEnv;

            // Store fallback env so status bar can show warning
            if (isFallback) {
                this.lastFallbackEnv = result.environment;
            } else {
                this.lastFallbackEnv = undefined;
            }

            // Only update currentEnvironment if it's not a fallback
            // This preserves the configured environment in the status bar
            if (!isFallback) {
                this.currentEnvironment = result.environment;
                this.emitStatus();
            }

            // Emit fallback event if warning is present (indicates fallback occurred)
            if (result.warning && requestedEnv) {
                const fallbackEvent: EnvironmentFallbackEvent = {
                    requestedEnv,
                    fallbackEnv: result.environment,
                    warning: result.warning,
                    requiredPackages: options.requiredPackages?.map((p) => p.name) || []
                };
                this._onEnvironmentFallback.fire(fallbackEvent);
            }
        }
        return result;
    }

    /**
     * Get the OpenMC cross-sections path.
     * Returns the configured path or environment variable.
     *
     * @returns The stored preference path, or `undefined` if not set.
     */
    getCrossSectionsPath(): string | undefined {
        // First check preference
        const prefPath = this.preferences.get('nuke.openmcCrossSections') as string;
        if (prefPath) {
            return prefPath;
        }

        // Check environment variable
        // Note: In browser, we can't access process.env directly
        // This would need to be fetched from backend
        return undefined;
    }

    /**
     * Set the OpenMC cross-sections path.
     * Saves to preferences.
     *
     * @param path - Absolute path to the cross-sections directory.
     * @returns Resolves when the preference has been saved.
     */
    async setCrossSectionsPath(path: string): Promise<void> {
        await this.preferences.set('nuke.openmcCrossSections', path);
    }

    /**
     * Get the OpenMC chain file path.
     * Returns the configured path or environment variable.
     *
     * @returns The stored preference path, or `undefined` if not set.
     */
    getChainFilePath(): string | undefined {
        const prefPath = this.preferences.get('nuke.openmcChainFile') as string;
        return prefPath || undefined;
    }

    /**
     * Set the OpenMC chain file path.
     * Saves to preferences.
     *
     * @param path - Absolute path to the chain file.
     * @returns Resolves when the preference has been saved.
     */
    async setChainFilePath(path: string): Promise<void> {
        await this.preferences.set('nuke.openmcChainFile', path);
    }

    /**
     * Validate configuration settings.
     *
     * @returns Validation result with any errors or warnings.
     */
    async validateConfig(): Promise<ConfigValidationResult> {
        return this.backend.validateConfig();
    }

    /**
     * Run health checks on the Nuke Core setup.
     *
     * @param packages - Optional packages to check for with metadata (e.g. `[{name: 'openmc', extraIndexUrl: '...'}]`).
     * @returns Comprehensive health check result.
     */
    async healthCheck(packages?: PackageDependency[]): Promise<HealthCheckResult> {
        return this.backend.healthCheck(packages);
    }

    /**
     * Get detailed diagnostics information for troubleshooting.
     *
     * @returns Key/value diagnostic data.
     */
    async getDiagnostics(): Promise<Record<string, unknown>> {
        return this.backend.getDiagnostics();
    }

    /**
     * Create a new Python environment (conda or venv).
     *
     * @param options - Creation options (name, type, packages, etc.).
     * @returns Result indicating success and the created environment.
     */
    async createEnvironment(options: CreateEnvironmentOptions): Promise<CreateEnvironmentResult> {
        const result = await this.backend.createEnvironment(options);
        if (result.success && result.environment) {
            this.clearCache();
        }
        return result;
    }

    /**
     * Prepare a shell command for creating an environment in a terminal.
     *
     * @param options - Creation options.
     * @returns The shell command and working directory.
     */
    async prepareCreateEnvironmentCommand(options: CreateEnvironmentOptions): Promise<CreateEnvironmentCommand> {
        return this.backend.prepareCreateEnvironmentCommand(options);
    }

    /**
     * Prepare a shell command for installing packages in a terminal.
     *
     * @param options - Install options (packages, channels, etc.).
     * @returns The shell command and working directory.
     */
    async prepareInstallPackagesCommand(options: PackageInstallOptions): Promise<{ command: string; cwd: string }> {
        return this.backend.prepareInstallPackagesCommand(options);
    }

    /**
     * Get the best available conda/mamba command.
     *
     * @returns The preferred command and its type, or `undefined` if none found.
     */
    async getCondaCommand(): Promise<{ cmd: string; type: 'conda' | 'mamba' } | undefined> {
        return this.backend.getCondaCommand();
    }

    /**
     * Delete a user-created environment.
     *
     * @param env - The environment to delete.
     * @returns Result indicating success and an optional error message.
     */
    async deleteEnvironment(env: NukeEnvironment): Promise<{ success: boolean; error?: string }> {
        const result = await this.backend.deleteEnvironment(env);

        if (result.success) {
            const wasConfigured =
                (this.currentConfig.condaEnv && env.name === this.currentConfig.condaEnv) ||
                this.currentConfig.pythonPath === env.pythonPath;

            if (wasConfigured) {
                // Use setConfig to properly clear everything and emit all events
                await this.setConfig({});
            } else if (this.currentEnvironment?.pythonPath === env.pythonPath) {
                // Deleted env was the active fallback but not the configured one
                this.currentEnvironment = undefined;
                this.lastFallbackEnv = undefined;
                this.emitStatus();
            }
        }

        return result;
    }

    private clearCache(): void {
        this.backend.setConfig({ ...this.currentConfig });
    }

    /**
     * Get current environment status.
     * Uses internal config state instead of preferences to avoid scope issues.
     *
     * @returns The current {@link EnvironmentStatus} snapshot.
     * @see {@link onStatusChanged}
     */
    getStatus(): EnvironmentStatus {
        // Use internal currentConfig instead of preferences to avoid workspace/user scope issues
        const hasConfig = !!(this.currentConfig.pythonPath || this.currentConfig.condaEnv);
        const visibilityRequested = this.visibilityService.isVisibilityRequested();

        if (!hasConfig) {
            return {
                configured: false,
                ready: false,
                message: 'Not configured',
                visibilityRequested
            };
        }

        if (this.currentEnvironment) {
            return {
                configured: true,
                ready: true,
                environment: this.currentEnvironment,
                fallbackEnvironment: this.lastFallbackEnv,
                message: `${this.currentEnvironment.name} (${this.currentEnvironment.version || 'unknown version'})`,
                visibilityRequested
            };
        }

        // Configured env name/path does not match any discovered environment
        return {
            configured: false,
            ready: false,
            message: 'Not configured',
            visibilityRequested
        };
    }

    /**
     * Quick check if Python is ready for use.
     *
     * @returns `true` when a Python command can be resolved.
     */
    async isReady(): Promise<boolean> {
        try {
            const cmd = await this.getPythonCommand();
            return !!cmd;
        } catch {
            return false;
        }
    }

    /**
     * Ensure environment is available, throwing a helpful error if not.
     *
     * @returns The resolved Python command path.
     * @throws When no environment is configured.
     */
    async requirePython(): Promise<string> {
        const cmd = await this.getPythonCommand();
        if (!cmd) {
            throw new Error('Environment not configured. Please set up in Settings → Nuke Utils.');
        }
        return cmd;
    }

    /**
     * Detect Python with required packages, with automatic suggestion for missing packages.
     * This is a convenience method that detects Python and provides actionable next steps.
     *
     * @param options - Detection options including required packages.
     * @returns Detection result with suggestion for missing packages.
     */
    async detectWithInstallSuggestion(options: PythonDetectionOptions): Promise<
        PythonDetectionResult & {
            missingPackages?: string[];
            suggestInstall?: boolean;
            installCommand?: string;
        }
    > {
        const result = await this.backend.detectPythonWithRequirements(options);

        if (result.success) {
            return { ...result, suggestInstall: false };
        }

        // If detection failed due to missing packages, suggest installation
        if (result.missingPackages && result.missingPackages.length > 0) {
            const packages = result.missingPackages;
            const cmd = result.command || (await this.getPythonCommand()) || 'python';

            return {
                ...result,
                missingPackages: packages,
                suggestInstall: true,
                installCommand: `${cmd} -m pip install ${packages.join(' ')}`
            };
        }

        return result;
    }

    // Private helpers

    private async updateCurrentEnvironment(): Promise<void> {
        try {
            const result = await this.backend.listEnvironments();
            const configuredConda = this.currentConfig.condaEnv;
            const configuredPath = this.currentConfig.pythonPath;

            if (configuredConda) {
                // Look for an environment whose name matches the configured conda env
                const match = result.environments.find((e) => e.name === configuredConda);
                this.currentEnvironment = match;
            } else if (configuredPath) {
                // Look for an environment whose pythonPath matches the configured path
                const match = result.environments.find((e) => e.pythonPath === configuredPath);
                this.currentEnvironment = match;
            } else {
                // No specific env configured — use the default selected one
                this.currentEnvironment = result.selected;
            }

            // If current environment now matches the configured env, clear the fallback
            const configuredName = configuredConda || configuredPath;
            if (configuredName && this.currentEnvironment?.name === configuredName) {
                this.lastFallbackEnv = undefined;
            }
        } catch (error) {
            console.error('[NukeCore] Failed to update current environment:', error);
        }
    }

    private emitStatus(): void {
        this._onStatusChanged.fire(this.getStatus());
    }
}
