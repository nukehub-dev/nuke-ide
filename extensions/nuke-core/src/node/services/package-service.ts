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

import * as path from 'path';
import { injectable, inject } from '@theia/core/shared/inversify';
import { PackageInstallOptions } from '../../common/nuke-core-protocol';
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

        let targetPython = explicitPythonPath;

        // If no explicit python path given, try to resolve the configured environment first
        // before falling back to the auto-detected (possibly fallback) python
        if (!targetPython) {
            const config = this.environmentService.getConfig();
            if (config.condaEnv) {
                const condaProvider = new CondaProvider();
                const envPath = await condaProvider.findEnvPath(config.condaEnv);
                if (envPath) {
                    targetPython = path.join(envPath, 'bin', 'python');
                }
            } else if (config.pythonPath) {
                targetPython = config.pythonPath;
            }
        }
        if (!targetPython) {
            targetPython = await this.environmentService.getPythonCommand() || 'python';
        }

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

}
