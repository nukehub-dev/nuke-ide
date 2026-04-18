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
    PythonEnvironment,
    PythonDetectionResult,
    PythonEnvironmentChangedEvent,
    PackageDependency,
    DependencyCheckResult,
    PythonDetectionOptions,
    PackageInstallOptions,
    PackageInstallResult,
    HealthCheckResult,
    ConfigValidationResult,
    EnvironmentStatus,
    NukeCoreStatusBarVisibility
} from '../common/nuke-core-protocol';
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
    private currentEnvironment?: PythonEnvironment;
    
    private readonly _onEnvironmentChanged = new Emitter<PythonEnvironmentChangedEvent>();
    readonly onEnvironmentChanged: Event<PythonEnvironmentChangedEvent> = this._onEnvironmentChanged.event;

    private readonly _onStatusChanged = new Emitter<EnvironmentStatus>();
    readonly onStatusChanged: Event<EnvironmentStatus> = this._onStatusChanged.event;

    @postConstruct()
    protected init(): void {
        console.log('[NukeCore] Service initialized');
        
        // Sync from preferences initially
        this.syncFromPreferences();
        
        // Listen for preference changes
        this.preferences.onPreferenceChanged(event => {
            if (event.preferenceName.startsWith('nuke.')) {
                console.log(`[NukeCore] Preference changed: ${event.preferenceName}`);
                this.syncFromPreferences();
            }
        });
    }

    /**
     * Sync configuration from nuke.* preferences.
     */
    protected async syncFromPreferences(): Promise<void> {
        const pythonPath = this.preferences.get('nuke.pythonPath') as string | undefined;
        const condaEnv = this.preferences.get('nuke.condaEnv') as string | undefined;
        
        const newConfig: PythonConfig = {
            pythonPath: pythonPath || undefined,
            condaEnv: condaEnv || undefined
        };
        
        if (newConfig.pythonPath !== this.currentConfig.pythonPath ||
            newConfig.condaEnv !== this.currentConfig.condaEnv) {
            await this.setConfig(newConfig);
        }
    }
    
    /**
     * Check if Nuke Core is properly configured.
     * Returns false if Python path or conda env is not set.
     */
    isConfigured(): boolean {
        const pythonPath = this.preferences.get('nuke.pythonPath') as string;
        const condaEnv = this.preferences.get('nuke.condaEnv') as string;
        return !!(pythonPath || condaEnv);
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
    async listEnvironments(searchWorkspace = false): Promise<PythonEnvironment[]> {
        const result = await this.backend.listEnvironments(searchWorkspace);
        return result.environments;
    }

    /**
     * Get the currently selected environment.
     */
    async getSelectedEnvironment(): Promise<PythonEnvironment | undefined> {
        const result = await this.backend.listEnvironments();
        return result.selected;
    }

    /**
     * Switch to a specific environment.
     * Updates preferences accordingly.
     */
    async switchToEnvironment(env: PythonEnvironment): Promise<void> {
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
     */
    async detectPythonWithRequirements(
        options: PythonDetectionOptions
    ): Promise<PythonDetectionResult & { missingPackages?: string[] }> {
        const result = await this.backend.detectPythonWithRequirements(options);
        if (result.environment) {
            this.currentEnvironment = result.environment;
            this.emitStatus();
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
     * Get current environment status.
     */
    getStatus(): EnvironmentStatus {
        const configured = this.isConfigured();
        const visibilityRequested = this.visibilityService.isVisibilityRequested();
        
        if (!configured) {
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
        } catch (error) {
            console.error('[NukeCore] Failed to update current environment:', error);
        }
    }

    private emitStatus(): void {
        this._onStatusChanged.fire(this.getStatus());
    }
}
