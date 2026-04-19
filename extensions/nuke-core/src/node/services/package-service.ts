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

import { injectable, inject } from '@theia/core/shared/inversify';
import {
    PackageInstallOptions,
    PackageInstallResult
} from '../../common/nuke-core-protocol';
import { CondaResolver } from './environment/utils/conda-resolver';
import { UvResolver } from './environment/utils/uv-resolver';
import { EnvironmentService } from './environment/environment-service';
import { CondaProvider } from './environment/providers/conda-provider';

@injectable()
export class PackageService {

    @inject(EnvironmentService)
    protected readonly environmentService: EnvironmentService;

    private readonly condaResolver = new CondaResolver();
    private readonly uvResolver = new UvResolver();

    async prepareInstallPackagesCommand(options: PackageInstallOptions): Promise<{ command: string; cwd: string }> {
        const {
            packages, pythonPath: explicitPythonPath, useConda = false,
            extraArgs = [], cwd: explicitCwd, channels, extraIndexUrl
        } = options;
        const targetPython = explicitPythonPath || await this.environmentService.getPythonCommand() || 'python';
        const cwd = explicitCwd || process.cwd();

        // Resolve conda channels: explicit > preference > default
        const condaChannels = channels?.length
            ? channels
            : this.environmentService.getConfig().condaChannels?.split(',').map(c => c.trim()).filter(Boolean)
            || ['conda-forge'];

        // Resolve pip extra index: explicit > preference
        const pipExtraIndex = extraIndexUrl || this.environmentService.getConfig().pipExtraIndexUrl || undefined;

        // Try conda/mamba first if requested
        if (useConda) {
            const best = await this.condaResolver.getBestCommand();
            if (best) {
                const config = this.environmentService.getConfig();
                let prefixArg: string[];
                if (config.condaEnv) {
                    // Resolve the actual env path so --prefix works across install locations
                    const condaProvider = new CondaProvider();
                    const envPath = await condaProvider.findEnvPath(config.condaEnv);
                    prefixArg = envPath ? ['--prefix', envPath] : ['-n', config.condaEnv];
                } else {
                    prefixArg = [];
                }
                const channelArgs = condaChannels.flatMap(c => ['-c', c]);
                const args = ['install', '-y', ...channelArgs, ...prefixArg, ...packages, ...extraArgs];
                return { command: `"${best.cmd}" ${args.join(' ')}`, cwd };
            }
        }

        // Build pip extra index args
        const indexArgs = pipExtraIndex ? ['--extra-index-url', pipExtraIndex] : [];

        // Try uv pip
        const uv = await this.uvResolver.findUvExe();
        if (uv) {
            const args = ['pip', 'install', ...packages, ...indexArgs, ...extraArgs];
            return { command: `"${uv}" ${args.join(' ')}`, cwd };
        }

        // Fall back to regular pip
        const args = ['-m', 'pip', 'install', ...packages, ...indexArgs, ...extraArgs];
        return { command: `"${targetPython}" ${args.join(' ')}`, cwd };
    }

    async installPackages(options: PackageInstallOptions): Promise<PackageInstallResult> {
        const { packages, pythonPath: explicitPythonPath, useConda = false, extraArgs = [], channels, extraIndexUrl } = options;

        // Use explicitly provided path, or detect from current config, or fall back to 'python'
        const targetPython = explicitPythonPath || await this.environmentService.getPythonCommand() || 'python';

        const installed: string[] = [];
        const failed: string[] = [];
        let output = '';

        // Resolve conda channels and pip extra index
        const condaChannels = channels?.length
            ? channels
            : this.environmentService.getConfig().condaChannels?.split(',').map(c => c.trim()).filter(Boolean)
            || ['conda-forge'];
        const pipExtraIndex = extraIndexUrl || this.environmentService.getConfig().pipExtraIndexUrl || undefined;
        const channelArgs = condaChannels.flatMap(c => ['-c', c]);
        const indexArgs = pipExtraIndex ? ['--extra-index-url', pipExtraIndex] : [];

        // Try conda/mamba first if requested
        if (useConda) {
            const best = await this.condaResolver.getBestCommand();
            const condaCmd = best?.cmd;

            if (condaCmd) {
                for (const pkg of packages) {
                    try {
                        const { execSync } = await import('child_process');
                        const args = ['install', '-y', ...channelArgs, pkg, ...extraArgs];
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
                // Conda/mamba not available — mark all as failed so pip/uv can try
                output += '\nConda/mamba not found. Falling back to pip/uv.\n';
                failed.push(...packages);
            }
        }

        // Fall back to uv/pip for failed packages or if not using conda
        const remainingPackages = useConda ? failed : packages;
        failed.length = 0;

        // Try uv pip first (much faster than regular pip)
        const uv = await this.uvResolver.findUvExe();
        const uvPackages: string[] = [];
        const pipPackages: string[] = [];

        if (uv) {
            for (const pkg of remainingPackages) {
                try {
                    const { execSync } = await import('child_process');
                    const args = ['pip', 'install', pkg, ...indexArgs, ...extraArgs];
                    const result = execSync(`"${uv}" ${args.join(' ')}`, {
                        encoding: 'utf-8',
                        timeout: 120000
                    });
                    output += result;
                    installed.push(pkg);
                } catch (error) {
                    uvPackages.push(pkg);
                    output += `\nFailed to install ${pkg} via uv: ${error}\n`;
                }
            }
        } else {
            // uv not available — send everything to pip
            pipPackages.push(...remainingPackages);
        }

        // Fall back to regular pip for packages uv couldn't install
        for (const pkg of uvPackages.length > 0 ? uvPackages : pipPackages) {
            try {
                const { execSync } = await import('child_process');
                const args = ['install', pkg, ...indexArgs, ...extraArgs];
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
