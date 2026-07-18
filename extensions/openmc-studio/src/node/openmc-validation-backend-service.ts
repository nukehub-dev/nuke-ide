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

/**
 * OpenMC Validation Backend Service
 *
 * Backend service for validating OpenMC environment setup.
 * Checks Python environment, OpenMC installation, cross-sections, and chain files.
 *
 * @module openmc-studio/node
 * @see {@link OpenMCRunnerService}
 */
@injectable()
export class OpenMCValidationBackendService {
    @inject(NukeCoreBackendService)
    protected readonly nukeCore: NukeCoreBackendServiceInterface;

    /**
     * Validate OpenMC setup on the backend.
     * Checks Python environment, OpenMC availability, cross-sections path, and chain file.
     * @returns Comprehensive validation result
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

        // Add fallback warning if present
        if (detection.warning) {
            warnings.push(detection.warning);
        }

        // Check cross-sections path (environment variable on backend)
        const crossSections = process.env.OPENMC_CROSS_SECTIONS;
        const crossSectionsSet = !!crossSections;
        if (!crossSectionsSet) {
            warnings.push(
                'Cross-sections path not set. Set OPENMC_CROSS_SECTIONS environment variable or configure in Settings → Nuke Utils.'
            );
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
     * @returns Python command and any warnings
     * @throws Error if OpenMC is not available
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
     * @returns Whether OpenMC can be found in any environment
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
     * @returns DAGMC availability with version information
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
            const depCheck = await this.nukeCore.checkDependencies([{ name: 'pydagmc' }, { name: 'pymoab' }], result.command);

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
