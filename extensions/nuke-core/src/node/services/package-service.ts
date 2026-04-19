// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

/**
 * Package Service
 *
 * Handles package installation and management.
 * Prefers mamba over conda when available for faster installs.
 *
 * @module nuke-core/node
 */

import { injectable } from '@theia/core/shared/inversify';
import {
    PackageInstallOptions,
    PackageInstallResult
} from '../../common/nuke-core-protocol';
import { CondaResolver } from './environment/utils/conda-resolver';

@injectable()
export class PackageService {

    private readonly condaResolver = new CondaResolver();

    async installPackages(options: PackageInstallOptions): Promise<PackageInstallResult> {
        const { packages, pythonPath, useConda = false, extraArgs = [] } = options;
        const targetPython = pythonPath || 'python';

        const installed: string[] = [];
        const failed: string[] = [];
        let output = '';

        // Try conda/mamba first if requested
        if (useConda) {
            const best = await this.condaResolver.getBestCommand();
            const condaCmd = best?.cmd;

            if (condaCmd) {
                for (const pkg of packages) {
                    try {
                        const { execSync } = await import('child_process');
                        const args = ['install', '-y', '-c', 'conda-forge', pkg, ...extraArgs];
                        const result = execSync(`${condaCmd} ${args.join(' ')}`, {
                            encoding: 'utf-8',
                            timeout: 120000
                        });
                        output += result;
                        installed.push(pkg);
                    } catch (error) {
                        failed.push(pkg);
                        output += `\nFailed to install ${pkg} via ${best?.type}: ${error}\n`;
                    }
                }
            } else {
                // Conda/mamba not available — mark all as failed so pip can try
                output += '\nConda/mamba not found. Falling back to pip.\n';
                failed.push(...packages);
            }
        }

        // Fall back to pip for failed packages or if not using conda
        const pipPackages = useConda ? failed : packages;
        failed.length = 0;

        for (const pkg of pipPackages) {
            try {
                const { execSync } = await import('child_process');
                const args = ['install', pkg, ...extraArgs];
                const result = execSync(`"${targetPython}" -m pip ${args.join(' ')}`, {
                    encoding: 'utf-8',
                    timeout: 120000
                });
                output += result;
                installed.push(pkg);
            } catch (error) {
                failed.push(pkg);
                output += `\nFailed to install ${pkg} via pip: ${error}\n`;
            }
        }

        return {
            success: failed.length === 0,
            installed,
            failed,
            output: output || undefined
        };
    }
}
