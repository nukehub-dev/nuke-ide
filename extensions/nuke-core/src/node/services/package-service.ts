// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

/**
 * Package Service
 * 
 * Handles package installation and management.
 * 
 * @module nuke-core/node
 */

import { injectable } from '@theia/core/shared/inversify';
import {
    PackageInstallOptions,
    PackageInstallResult
} from '../../common/nuke-core-protocol';

@injectable()
export class PackageService {
    
    async installPackages(options: PackageInstallOptions): Promise<PackageInstallResult> {
        const { packages, pythonPath, useConda = false, extraArgs = [] } = options;
        const targetPython = pythonPath || 'python';
        
        const installed: string[] = [];
        const failed: string[] = [];
        let output = '';
        
        // Try conda first if requested
        if (useConda) {
            for (const pkg of packages) {
                try {
                    const { execSync } = await import('child_process');
                    const args = ['install', '-y', '-c', 'conda-forge', pkg, ...extraArgs];
                    const result = execSync(`conda ${args.join(' ')}`, { 
                        encoding: 'utf-8',
                        timeout: 120000
                    });
                    output += result;
                    installed.push(pkg);
                } catch (error) {
                    failed.push(pkg);
                    output += `\nFailed to install ${pkg} via conda: ${error}\n`;
                }
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
