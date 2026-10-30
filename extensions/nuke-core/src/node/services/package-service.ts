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
import { DependencyInstallCommand, PackageDependency, PackageInstallOptions } from '../../common/nuke-core-protocol';
import { CondaResolver } from './environment/utils/conda-resolver';
import { UvResolver } from './environment/utils/uv-resolver';
import { getPythonInfo } from './environment/utils/python-info';
import { EnvironmentService } from './environment/environment-service';
import { CondaProvider } from './environment/providers/conda-provider';
import { buildDependencyInstallPlan } from './dependency-install-planner';

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
            packages,
            pythonPath: explicitPythonPath,
            useConda = false,
            extraArgs = [],
            cwd: explicitCwd,
            channels,
            extraIndexUrl
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
            targetPython = (await this.environmentService.getPythonCommand()) || 'python';
        }

        const cwd = explicitCwd || process.cwd();

        // Resolve conda channels: explicit > preference > default
        const condaChannels = channels?.length
            ? channels
            : this.environmentService
                  .getConfig()
                  .condaChannels?.split(',')
                  .map((c) => c.trim())
                  .filter(Boolean) || ['conda-forge'];

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
                const channelArgs = condaChannels.flatMap((c) => ['-c', c]);
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

    /**
     * Build the ordered shell commands for installing structured package dependencies.
     *
     * Routes the entries through {@link buildDependencyInstallPlan} — a conda batch for
     * `condaOnly`/`condaSpec` entries (conda envs only) plus one pip command per
     * (`extraIndexUrl`, `pipArgs`) signature — then prepares each group with
     * {@link prepareInstallPackagesCommand}, reusing its conda-prefix / uv / pip
     * resolution and quoting. `condaOnly` entries in a non-conda env cannot be
     * auto-installed and produce no command.
     *
     * @param defs - The {@link PackageDependency} entries to install (typically the missing ones)
     * @param pythonPath - Optional explicit target Python (defaults to configured env → configured path → auto-detected)
     * @returns A promise resolving to the ordered list of commands to execute (conda batch first, then pip groups)
     * @throws Never throws; missing inputs fall back to sensible defaults
     * @see {@link buildDependencyInstallPlan}
     * @see {@link prepareInstallPackagesCommand}
     */
    async prepareDependencyInstallCommands(defs: PackageDependency[], pythonPath?: string): Promise<DependencyInstallCommand[]> {
        const config = this.environmentService.getConfig();

        // Resolve the target interpreter exactly like prepareInstallPackagesCommand
        let targetPython = pythonPath;
        let fromCondaConfig = false;
        if (!targetPython) {
            if (config.condaEnv) {
                const condaProvider = new CondaProvider();
                const envPath = await condaProvider.findEnvPath(config.condaEnv);
                if (envPath) {
                    targetPython = path.join(envPath, 'bin', 'python');
                    fromCondaConfig = true;
                }
            } else if (config.pythonPath) {
                targetPython = config.pythonPath;
            }
        }
        if (!targetPython) {
            targetPython = (await this.environmentService.getPythonCommand()) || 'python';
        }

        // Inspect the interpreter to detect a conda prefix (getPythonInfo reclassifies
        // conda pythons discovered as bare system interpreters); fall back to the config
        const info = await getPythonInfo(targetPython, 'system');
        const isCondaEnv = info ? info.type === 'conda' : fromCondaConfig;

        const plan = buildDependencyInstallPlan(defs, isCondaEnv);
        const commands: DependencyInstallCommand[] = [];

        if (plan.conda) {
            const prepared = await this.prepareInstallPackagesCommand({
                packages: plan.conda.specs,
                pythonPath: targetPython,
                useConda: true,
                channels: plan.conda.channels
            });
            commands.push({
                label: `Install (conda): ${plan.conda.specs.join(' ')}`,
                command: prepared.command,
                cwd: prepared.cwd
            });
        }

        for (const group of plan.pip) {
            const prepared = await this.prepareInstallPackagesCommand({
                packages: group.specs,
                pythonPath: targetPython,
                extraArgs: group.args,
                extraIndexUrl: group.extraIndexUrl
            });
            commands.push({
                label: `Install (pip): ${group.specs.join(' ')}`,
                command: prepared.command,
                cwd: prepared.cwd
            });
        }

        return commands;
    }
}
