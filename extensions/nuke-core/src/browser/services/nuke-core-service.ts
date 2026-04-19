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
 * Nuke Core Frontend Service
 * 
 * Provides core infrastructure services for all NukeIDE extensions:
 * - Environment management (Python/Conda)
 * - Configuration management
 * - Package management
 * - Health checks
 * - Shared utilities
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
    PackageInstallResult,
    HealthCheckResult,
    ConfigValidationResult,
    EnvironmentStatus,
    NukeCoreStatusBarVisibility,
    CreateEnvironmentOptions,
    CreateEnvironmentResult,
    CreateEnvironmentCommand
} from '../../common/nuke-core-protocol';
import { NukeCoreVisibilityService } from './nuke-core-visibility-service';

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
    
    private readonly _onEnvironmentChanged = new Emitter<NukeEnvironmentChangedEvent>();
    readonly onEnvironmentChanged: Event<NukeEnvironmentChangedEvent> = this._onEnvironmentChanged.event;

    private readonly _onStatusChanged = new Emitter<EnvironmentStatus>();
    readonly onStatusChanged: Event<EnvironmentStatus> = this._onStatusChanged.event;

    private readonly _onEnvironmentFallback = new Emitter<EnvironmentFallbackEvent>();
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
     */
    readonly onEnvironmentFallback: Event<EnvironmentFallbackEvent> = this._onEnvironmentFallback.event;

    @postConstruct()
    protected init(): void {
        console.log('[NukeCore] Service initialized');
        
        // Sync from preferences initially
        this.syncFromPreferences();
        
        // Listen for preference changes
        this.preferences.onPreferenceChanged(event => {
            if (event.preferenceName.startsWith('nuke.')) {
                console.log('[NukeCore] Preference changed:', event.preferenceName);
                // Use setTimeout to ensure the preference has been fully processed
                setTimeout(() => this.syncFromPreferences(), 0);
            }
        });
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
        
        let pythonPath: string | undefined;
        let condaEnv: string | undefined;
        
        // Only use values if they are explicitly set (non-empty)
        // Priority: workspaceFolderValue > workspaceValue > globalValue (user)
        // This avoids the Theia scope merge bug where empty workspace overrides user settings
        if (inspectPath?.workspaceFolderValue?.trim()) {
            pythonPath = inspectPath.workspaceFolderValue as string;
        } else if (inspectPath?.workspaceValue?.trim()) {
            pythonPath = inspectPath.workspaceValue as string;
        } else if (inspectPath?.globalValue?.trim()) {
            pythonPath = inspectPath.globalValue as string;
        }
        
        if (inspectEnv?.workspaceFolderValue?.trim()) {
            condaEnv = inspectEnv.workspaceFolderValue as string;
        } else if (inspectEnv?.workspaceValue?.trim()) {
            condaEnv = inspectEnv.workspaceValue as string;
        } else if (inspectEnv?.globalValue?.trim()) {
            condaEnv = inspectEnv.globalValue as string;
        }
        
        // CRITICAL: If preferences are empty but we already have a valid config, DON'T OVERWRITE IT
        // This handles the case where workspace scope returns "" while user scope has the real value
        // We only allow clearing if explicitly set to empty, not from scope merge issues
        const hasExistingConfig = this.currentConfig.pythonPath || this.currentConfig.condaEnv;
        const hasNewPrefs = pythonPath || condaEnv;
        
        if (!hasNewPrefs && hasExistingConfig) {
            return;
        }
        
        // Also skip if values haven't changed
        if (pythonPath === this.currentConfig.pythonPath && condaEnv === this.currentConfig.condaEnv) {
            return;
        }
        
        const newConfig: PythonConfig = {
            pythonPath: pythonPath || undefined,
            condaEnv: condaEnv || undefined
        };
        
        await this.setConfig(newConfig);
    }
    
    /**
     * Check if Nuke Core is properly configured.
     * Returns false if Python path or conda env is not set.
     * Uses internal currentConfig to avoid Theia preference scope merging issues.
     */
    isConfigured(): boolean {
        return !!(this.currentConfig.pythonPath || this.currentConfig.condaEnv);
    }
    
    /**
     * Get configuration error message if not configured.
     */
    getConfigError(): string | undefined {
        if (this.isConfigured()) {
            return undefined;
        }
        return 'Nuke is not configured. Please set environment in Settings → Nuke Utils.';
    }

    /**
     * Set environment configuration.
     */
    async setConfig(config: PythonConfig): Promise<void> {
        const previous = { ...this.currentConfig };
        const previousEnv = this.currentEnvironment;
        this.currentConfig = { ...config };
        await this.backend.setConfig(config);
        
        // Clear fallback when config changes
        this.lastFallbackEnv = undefined;
        
        // Update current environment info
        await this.updateCurrentEnvironment();
        
        this._onEnvironmentChanged.fire({ 
            previous, 
            current: config,
            previousEnv,
            currentEnv: this.currentEnvironment
        });
        
        this.emitStatus();
    }

    /**
     * Get current Python configuration.
     */
    async getConfig(): Promise<PythonConfig> {
        return this.backend.getConfig();
    }

    /**
     * Get the Python command to use (cached).
     */
    async getPythonCommand(): Promise<string | undefined> {
        return this.backend.getPythonCommand();
    }

    /**
     * Detect Python command based on current config.
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
     * @param searchWorkspace Also search for venvs in workspace
     */
    async listEnvironments(searchWorkspace = false): Promise<NukeEnvironment[]> {
        const result = await this.backend.listEnvironments(searchWorkspace);
        return result.environments;
    }

    /**
     * Get the currently selected environment.
     */
    async getSelectedEnvironment(): Promise<NukeEnvironment | undefined> {
        const result = await this.backend.listEnvironments();
        return result.selected;
    }

    /**
     * Switch to a specific environment.
     * Updates preferences accordingly.
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
     */
    async checkDependencies(
        packages: PackageDependency[], 
        pythonPath?: string
    ): Promise<DependencyCheckResult> {
        return this.backend.checkDependencies(packages, pythonPath);
    }

    /**
     * Detect Python with specific package requirements.
     * Emits onEnvironmentFallback if a fallback to a different environment occurs.
     * 
     * Note: This does NOT update currentEnvironment when a fallback occurs.
     * The status bar should show the configured environment, not a fallback.
     */
    async detectPythonWithRequirements(
        options: PythonDetectionOptions
    ): Promise<PythonDetectionResult & { missingPackages?: string[] }> {
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
                    requiredPackages: options.requiredPackages?.map(p => p.name) || []
                };
                this._onEnvironmentFallback.fire(fallbackEvent);
            }
        }
        return result;
    }

    /**
     * Install packages in the current or specified Python environment.
     */
    async installPackages(options: PackageInstallOptions): Promise<PackageInstallResult> {
        return this.backend.installPackages(options);
    }

    /**
     * Convenience method to install missing packages.
     */
    async installMissingPackages(
        packages: string[], 
        pythonPath?: string
    ): Promise<PackageInstallResult> {
        return this.installPackages({
            packages,
            pythonPath,
            useConda: false // Try pip first
        });
    }

    /**
     * Get the OpenMC cross-sections path.
     * Returns the configured path or environment variable.
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
     */
    async setCrossSectionsPath(path: string): Promise<void> {
        await this.preferences.set('nuke.openmcCrossSections', path);
    }
    
    /**
     * Get the OpenMC chain file path.
     * Returns the configured path or environment variable.
     */
    getChainFilePath(): string | undefined {
        const prefPath = this.preferences.get('nuke.openmcChainFile') as string;
        return prefPath || undefined;
    }
    
    /**
     * Set the OpenMC chain file path.
     * Saves to preferences.
     */
    async setChainFilePath(path: string): Promise<void> {
        await this.preferences.set('nuke.openmcChainFile', path);
    }

    /**
     * Validate configuration settings.
     */
    async validateConfig(): Promise<ConfigValidationResult> {
        return this.backend.validateConfig();
    }

    /**
     * Run health checks on the Nuke Core setup.
     * @param packages Optional packages to check for (e.g., ['openmc', 'numpy'])
     */
    async healthCheck(packages?: string[]): Promise<HealthCheckResult> {
        return this.backend.healthCheck(packages);
    }

    /**
     * Get detailed diagnostics information for troubleshooting.
     */
    async getDiagnostics(): Promise<Record<string, unknown>> {
        return this.backend.getDiagnostics();
    }

    /**
     * Create a new Python environment (conda or venv).
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
     */
    async prepareCreateEnvironmentCommand(options: CreateEnvironmentOptions): Promise<CreateEnvironmentCommand> {
        return this.backend.prepareCreateEnvironmentCommand(options);
    }

    /**
     * Prepare a shell command for installing packages in a terminal.
     */
    async prepareInstallPackagesCommand(options: PackageInstallOptions): Promise<{ command: string; cwd: string }> {
        return this.backend.prepareInstallPackagesCommand(options);
    }

    /**
     * Get the best available conda/mamba command.
     */
    async getCondaCommand(): Promise<{ cmd: string; type: 'conda' | 'mamba' } | undefined> {
        return this.backend.getCondaCommand();
    }

    /**
     * Delete a user-created environment.
     */
    async deleteEnvironment(env: NukeEnvironment): Promise<{ success: boolean; error?: string }> {
        return this.backend.deleteEnvironment(env);
    }

    private clearCache(): void {
        this.backend.setConfig({ ...this.currentConfig });
    }

    /**
     * Get current environment status.
     * Uses internal config state instead of preferences to avoid scope issues.
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

        return {
            configured: true,
            ready: false,
            message: 'Detecting environment...',
            visibilityRequested
        };
    }

    /**
     * Quick check if Python is ready for use.
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
     * @returns Detection result with suggestion for missing packages
     */
    async detectWithInstallSuggestion(
        options: PythonDetectionOptions
    ): Promise<PythonDetectionResult & { 
        missingPackages?: string[];
        suggestInstall?: boolean;
        installCommand?: string;
    }> {
        const result = await this.backend.detectPythonWithRequirements(options);
        
        if (result.success) {
            return { ...result, suggestInstall: false };
        }
        
        // If detection failed due to missing packages, suggest installation
        if (result.missingPackages && result.missingPackages.length > 0) {
            const packages = result.missingPackages;
            const cmd = result.command || await this.getPythonCommand() || 'python';
            
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
            this.currentEnvironment = result.selected;
            
            // If current environment now matches the configured env, clear the fallback
            const configuredName = this.currentConfig.condaEnv || this.currentConfig.pythonPath;
            if (configuredName && result.selected?.name === configuredName) {
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
