// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

/**
 * Package Service
 *
 * Handles package installation command preparation for the Nuke Core backend.
 * Given a set of packages and installation preferences, constructs the optimal
 * shell command without executing it.
 *
 * Installer priority:
 * 1. **Conda / Mamba** – used when `useConda: true` and a conda/mamba executable is found
 * 2. **UV** – used when `uv` is installed on the system
 * 3. **pip** – fallback using the target Python interpreter
 *
 * The service resolves the target Python interpreter from (in order):
 * - Explicit `pythonPath` in the options
 * - Configured conda environment → its Python binary
 * - Configured `pythonPath` in global settings
 * - Auto-detected Python (possibly a fallback)
 *
 * This service is intended to be consumed by {@link NukeCoreBackendServiceImpl}
 * and is bound as a singleton in the Inversify container.
 *
 * @module nuke-core/node
 * @see {@link NukeCoreBackendServiceImpl}
 * @see {@link EnvironmentService}
 * @see {@link CondaResolver}
 * @see {@link UvResolver}
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

    /**
     * Build a package installation command for the given set of packages and preferences.
     *
     * The method performs the following resolution steps:
     * 1. Determine the target Python interpreter (explicit → configured conda → configured path → auto-detected)
     * 2. Determine the working directory (explicit `cwd` → `process.cwd()`)
     * 3. Resolve conda channels and pip extra index URL
     * 4. Select the best available installer (conda/mamba → uv → pip) and format the command
     *
     * @param options - {@link PackageInstallOptions} controlling packages, channels, conda vs pip, extra args, etc.
     * @returns A promise resolving to an object with:
     *   - `command`: The fully-formed shell command string ready to execute
     *   - `cwd`: The working directory in which the command should run
     * @throws Never throws; missing inputs fall back to sensible defaults
     * @see {@link CondaResolver.getBestCommand}
     * @see {@link UvResolver.findUvExe}
     * @see {@link CondaProvider.findEnvPath}
     */
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
