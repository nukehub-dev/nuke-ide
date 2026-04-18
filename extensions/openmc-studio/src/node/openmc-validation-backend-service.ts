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
 * OpenMC Validation Backend Service
 * 
 * Backend service for OpenMC-specific validation.
 * Uses nuke-core for environment detection.
 * 
 * @module openmc-studio/node
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { NukeCoreBackendService, NukeCoreBackendServiceInterface } from 'nuke-core/lib/common';

export interface OpenMCValidationResult {
    ready: boolean;
    environmentConfigured: boolean;
    openmcAvailable: boolean;
    crossSectionsSet: boolean;
    chainFileSet: boolean;
    errors: string[];
    warnings: string[];
    pythonCommand?: string;
}

@injectable()
export class OpenMCValidationBackendService {
    
    @inject(NukeCoreBackendService)
    protected readonly nukeCore: NukeCoreBackendServiceInterface;

    /**
     * Validate OpenMC setup on the backend.
     */
    async validateOpenMCSetup(): Promise<OpenMCValidationResult> {
        const errors: string[] = [];
        const warnings: string[] = [];
        
        // Get current config
        const config = await this.nukeCore.getConfig();
        const environmentConfigured = !!(config.pythonPath || config.condaEnv);
        
        // Check environment with OpenMC requirement
        const detection = await this.nukeCore.detectPythonWithRequirements({
            requiredPackages: [{ name: 'openmc' }],
            searchWorkspaceVenvs: true
        });
        
        const openmcAvailable = detection.success;
        
        if (!detection.success) {
            if (environmentConfigured) {
                errors.push(`Configured environment does not have OpenMC. ${detection.error || 'Install OpenMC or switch environment.'}`);
            } else {
                errors.push(`No environment with OpenMC found. ${detection.error || 'Configure environment in Settings → Nuke Utils.'}`);
            }
        }
        
        // Check cross-sections path (environment variable on backend)
        const crossSections = process.env.OPENMC_CROSS_SECTIONS;
        const crossSectionsSet = !!crossSections;
        if (!crossSectionsSet) {
            warnings.push('Cross-sections path not set. Set OPENMC_CROSS_SECTIONS environment variable or configure in Settings → Nuke Utils.');
        }
        
        // Check chain file (not required for all simulations)
        const chainFile = process.env.OPENMC_CHAIN_FILE;
        const chainFileSet = !!chainFile;
        // Note: Chain file is optional - only needed for depletion
        
        // Ready if OpenMC is available (cross-sections can be set at runtime)
        const ready = openmcAvailable;
        
        return {
            ready,
            environmentConfigured,
            openmcAvailable,
            crossSectionsSet,
            chainFileSet,
            errors,
            warnings,
            pythonCommand: detection.command
        };
    }

    /**
     * Get Python command with OpenMC, with auto-detection fallback.
     */
    async getPythonWithOpenMC(): Promise<{ 
        command: string; 
        warning?: string;
        envName?: string;
    }> {
        const validation = await this.validateOpenMCSetup();
        
        if (!validation.ready || !validation.pythonCommand) {
            throw new Error(validation.errors.join('\n') || 'OpenMC not available');
        }
        
        return {
            command: validation.pythonCommand,
            warning: validation.warnings.join('\n') || undefined
        };
    }

    /**
     * Quick check if OpenMC is available.
     */
    async isOpenMCAvailable(): Promise<boolean> {
        try {
            const result = await this.nukeCore.detectPythonWithRequirements({
                requiredPackages: [{ name: 'openmc' }]
            });
            return result.success;
        } catch {
            return false;
        }
    }

    /**
     * Validate DAGMC setup (pydagmc + pymoab).
     */
    async validateDAGMC(): Promise<{
        available: boolean;
        pythonCommand?: string;
        pydagmcVersion?: string;
        pymoabVersion?: string;
        error?: string;
    }> {
        try {
            const result = await this.nukeCore.detectPythonWithRequirements({
                requiredPackages: [
                    { name: 'pydagmc', required: true },
                    { name: 'pymoab', required: false }
                ],
                searchWorkspaceVenvs: true
            });

            if (!result.success || !result.command) {
                return {
                    available: false,
                    error: result.error || 'pydagmc not found in any environment'
                };
            }

            // Get versions
            const depCheck = await this.nukeCore.checkDependencies(
                [{ name: 'pydagmc' }, { name: 'pymoab' }],
                result.command
            );

            return {
                available: true,
                pythonCommand: result.command,
                pydagmcVersion: depCheck.versions['pydagmc'],
                pymoabVersion: depCheck.versions['pymoab']
            };
        } catch (error) {
            return {
                available: false,
                error: String(error)
            };
        }
    }
}
