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
 * OpenMC Validation Service
 * 
 * OpenMC-specific validation that uses nuke-core for environment detection.
 * This was moved from nuke-core to keep the core generic.
 * 
 * @module openmc-studio/browser
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { MessageService } from '@theia/core/lib/common/message-service';
import { NukeCoreService } from 'nuke-core/lib/common';

export interface OpenMCValidationResult {
    /** Whether OpenMC is ready to use */
    ready: boolean;
    /** Whether environment is configured */
    environmentConfigured: boolean;
    /** Whether OpenMC package is available */
    openmcAvailable: boolean;
    /** Whether cross-sections path is set */
    crossSectionsSet: boolean;
    /** Whether chain file is set */
    chainFileSet: boolean;
    /** Validation errors */
    errors: string[];
    /** Validation warnings */
    warnings: string[];
    /** The detected Python command (if found) */
    pythonCommand?: string;
    /** The detected environment (if found) */
    environment?: {
        name: string;
        version?: string;
        type: string;
    };
}

@injectable()
export class OpenMCValidationService {
    
    @inject(NukeCoreService)
    protected readonly nukeCore: NukeCoreService;

    @inject(MessageService)
    protected readonly messageService: MessageService;

    /**
     * Validate OpenMC setup.
     * Checks: Environment configured, OpenMC available, cross-sections path set.
     * 
     * @returns Detailed validation result
     */
    async validateOpenMCSetup(): Promise<OpenMCValidationResult> {
        const errors: string[] = [];
        const warnings: string[] = [];
        
        // Check environment detection with OpenMC requirement
        const detection = await this.nukeCore.detectPythonWithRequirements({
            requiredPackages: [{ name: 'openmc' }],
            searchWorkspaceVenvs: true
        });
        
        const environmentConfigured = detection.success || this.nukeCore.isConfigured();
        const openmcAvailable = detection.success;
        
        if (!detection.success) {
            if (this.nukeCore.isConfigured()) {
                errors.push(`Configured environment does not have OpenMC. ${detection.error || 'Install OpenMC or switch environment.'}`);
            } else {
                errors.push(`No environment with OpenMC found. ${detection.error || 'Configure environment in Settings → Nuke Utils.'}`);
            }
        }
        
        // Check cross-sections path
        const crossSectionsPath = this.nukeCore.getCrossSectionsPath();
        const crossSectionsSet = !!crossSectionsPath;
        if (!crossSectionsSet) {
            warnings.push('Cross-sections path not set. Set nuke.openmcCrossSections in Settings, or set OPENMC_CROSS_SECTIONS environment variable.');
        }
        
        // Check chain file
        const chainFilePath = this.nukeCore.getChainFilePath();
        const chainFileSet = !!chainFilePath;
        if (!chainFileSet) {
            warnings.push('Chain file not set. Set nuke.openmcChainFile in Settings, or set OPENMC_CHAIN_FILE environment variable.');
        }
        
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
            pythonCommand: detection.command,
            environment: detection.environment ? {
                name: detection.environment.name,
                version: detection.environment.version,
                type: detection.environment.type
            } : undefined
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
     * Get a human-readable status message for OpenMC.
     */
    async getStatusMessage(): Promise<string> {
        const validation = await this.validateOpenMCSetup();
        
        if (validation.ready) {
            const env = validation.environment;
            return `OpenMC ready (${env?.name}${env?.version ? ' ' + env.version : ''})`;
        }
        
        if (validation.errors.length > 0) {
            return validation.errors[0];
        }
        
        return 'OpenMC not configured';
    }

    /**
     * Validate DAGMC setup (pydagmc + pymoab).
     */
    async validateDAGMC(): Promise<{
        available: boolean;
        pythonCommand?: string;
        pydagmcVersion?: string;
        pymoabVersion?: string;
        warning?: string;
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

            // Notify user if a fallback occurred
            if (result.warning) {
                this.messageService.warn(result.warning);
            }

            return {
                available: true,
                pythonCommand: result.command,
                pydagmcVersion: depCheck.versions['pydagmc'],
                pymoabVersion: depCheck.versions['pymoab'],
                warning: result.warning
            };
        } catch (error) {
            return {
                available: false,
                error: String(error)
            };
        }
    }
}
