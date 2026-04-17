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
 * - Python environment management
 * - Configuration management (Python path, cross-sections)
 * - OpenMC availability checking
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
    PythonEnvironmentChangedEvent
} from '../common/nuke-core-protocol';

@injectable()
export class NukeCoreService {
    
    @inject(NukeCoreBackendService)
    protected readonly backend: NukeCoreBackendServiceInterface;
    
    @inject(PreferenceService)
    protected readonly preferences: PreferenceService;

    private currentConfig: PythonConfig = {};
    
    private readonly _onEnvironmentChanged = new Emitter<PythonEnvironmentChangedEvent>();
    readonly onEnvironmentChanged: Event<PythonEnvironmentChangedEvent> = this._onEnvironmentChanged.event;

    @postConstruct()
    protected init(): void {
        console.log('[NukeCore] Service initialized');
        
        // Sync from preferences initially
        this.syncFromPreferences();
        
        // Listen for preference changes
        this.preferences.onPreferenceChanged(event => {
            if (event.preferenceName === 'nuke.pythonPath' ||
                event.preferenceName === 'nuke.condaEnv' ||
                event.preferenceName === 'nuke.openmcCrossSections' ||
                event.preferenceName === 'nuke.openmcChainFile') {
                console.log(`[NukeCore] Preference changed: ${event.preferenceName}`);
                this.syncFromPreferences();
            }
        });
    }

    /**
     * Sync configuration from nuke.* preferences.
     */
    protected syncFromPreferences(): void {
        const pythonPath = this.preferences.get('nuke.pythonPath') as string | undefined;
        const condaEnv = this.preferences.get('nuke.condaEnv') as string | undefined;
        
        const newConfig: PythonConfig = {
            pythonPath: pythonPath || undefined,
            condaEnv: condaEnv || undefined
        };
        
        if (newConfig.pythonPath !== this.currentConfig.pythonPath ||
            newConfig.condaEnv !== this.currentConfig.condaEnv) {
            this.setConfig(newConfig);
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
        return 'Nuke Core is not configured. Please set Python Path or Conda Environment in Settings → Nuke Utils.';
    }

    /**
     * Set Python configuration.
     */
    async setConfig(config: PythonConfig): Promise<void> {
        const previous = { ...this.currentConfig };
        this.currentConfig = { ...config };
        await this.backend.setConfig(config);
        this._onEnvironmentChanged.fire({ previous, current: config });
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
        return this.backend.detectPython();
    }

    /**
     * List available Python environments.
     */
    async listEnvironments(): Promise<PythonEnvironment[]> {
        const result = await this.backend.listEnvironments();
        return result.environments;
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
        
        // Otherwise return undefined (backend will check env var)
        return undefined;
    }
    
    /**
     * Set the OpenMC cross-sections path.
     */
    async setCrossSectionsPath(path: string): Promise<void> {
        // Note: This would need to be saved to preferences
        // For now, just log it - actual implementation would use PreferenceService
        console.log(`[NukeCore] Cross-sections path set to: ${path}`);
    }
    
    /**
     * Get the OpenMC chain file path.
     * Returns the configured path or environment variable.
     */
    getChainFilePath(): string | undefined {
        // First check preference
        const prefPath = this.preferences.get('nuke.openmcChainFile') as string;
        if (prefPath) {
            return prefPath;
        }
        
        // Otherwise return undefined (backend will check env var)
        return undefined;
    }
    
    /**
     * Set the OpenMC chain file path.
     */
    async setChainFilePath(path: string): Promise<void> {
        // Note: This would need to be saved to preferences
        // For now, just log it - actual implementation would use PreferenceService
        console.log(`[NukeCore] Chain file path set to: ${path}`);
    }
    
    /**
     * Validate that OpenMC is ready to use.
     * Checks: Python configured, OpenMC available, cross-sections path set.
     * Returns detailed validation result.
     */
    async validateOpenMCSetup(): Promise<{
        ready: boolean;
        pythonConfigured: boolean;
        openmcAvailable: boolean;
        crossSectionsSet: boolean;
        errors: string[];
        warnings: string[];
    }> {
        const errors: string[] = [];
        const warnings: string[] = [];
        
        // Check Python detection with OpenMC requirement (auto-detects if not configured)
        const pythonDetection = await this.backend.detectPythonWithRequirements({
            requiredPackages: [{ name: 'openmc' }],
            autoDetectEnvs: ['openmc', 'nuke-ide', 'visualizer', 'trame']
        });
        const pythonConfigured = pythonDetection.success || this.isConfigured();
        if (!pythonDetection.success) {
            errors.push(`Python detection failed: ${pythonDetection.error || 'Could not find Python with OpenMC'}. Set nuke.pythonPath or nuke.condaEnv in Settings.`);
        }
        
        // OpenMC is guaranteed available if pythonDetection succeeded
        const openmcAvailable = pythonDetection.success;
        
        // Check cross-sections path
        const crossSectionsPath = this.getCrossSectionsPath();
        const crossSectionsSet = !!crossSectionsPath;
        if (!crossSectionsSet) {
            warnings.push('Cross-sections path not set. Set nuke.openmcCrossSections in Settings, or set OPENMC_CROSS_SECTIONS environment variable.');
        }
        
        return {
            ready: pythonDetection.success && openmcAvailable,
            pythonConfigured,
            openmcAvailable,
            crossSectionsSet,
            errors,
            warnings
        };
    }
}
