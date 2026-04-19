// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

/**
 * Conda Provider
 *
 * Discovers conda and mamba environments across all common installation
 * locations (Anaconda, Miniconda, Miniforge, Mambaforge, etc.).
 *
 * Prefers mamba over conda when available for faster operations.
 *
 * @module nuke-core/node
 */

import { NukeEnvironment } from '../../../../common/nuke-core-protocol';
import { EnvironmentProvider } from './base';
import { CondaResolver, CondaInstallation } from '../utils/conda-resolver';
import { getPythonInfo } from '../utils/python-info';

export class CondaProvider implements EnvironmentProvider {
    readonly name = 'conda';
    private readonly resolver: CondaResolver;
    private cachedInstallations?: CondaInstallation[];

    constructor() {
        this.resolver = new CondaResolver();
    }

    async isAvailable(): Promise<boolean> {
        const best = await this.resolver.getBestCommand();
        return best !== undefined;
    }

    async listEnvironments(): Promise<NukeEnvironment[]> {
        const environments: NukeEnvironment[] = [];
        const best = await this.resolver.getBestCommand();
        if (!best) {
            return environments;
        }

        try {
            const { execSync } = await import('child_process');
            const output = execSync(`${best.cmd} env list --json`, { encoding: 'utf-8' });
            const result = JSON.parse(output);
            const path = await import('path');
            const isWindows = process.platform === 'win32';

            for (const env of result.envs) {
                const envPath: string = env;
                const pythonPath = path.join(
                    envPath,
                    isWindows ? 'python.exe' : 'bin/python'
                );

                try {
                    const fs = await import('fs');
                    await fs.promises.access(pythonPath);
                    const envInfo = await getPythonInfo(pythonPath, 'conda');
                    if (envInfo) {
                        const baseName = path.basename(envPath);
                        envInfo.name = (baseName === 'bin' || baseName === '') ? 'base' : baseName;
                        environments.push(envInfo);
                    }
                } catch {
                    // Python executable not found in this env
                }
            }
        } catch {
            // Conda/mamba not available or error parsing output
        }

        return environments;
    }

    async findPython(envName: string = 'base'): Promise<string | undefined> {
        const best = await this.resolver.getBestCommand();
        if (!best) {
            return undefined;
        }

        const isWindows = process.platform === 'win32';
        const path = await import('path');
        const fs = await import('fs');

        // 1. Try conda/mamba run to resolve the Python path
        try {
            const { execSync } = await import('child_process');
            const whichCmd = isWindows ? 'where python' : 'which python';
            const output = execSync(`${best.cmd} run -n ${envName} ${whichCmd}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
            const firstLine = output.trim().split(/\r?\n/)[0];
            if (firstLine) {
                return firstLine;
            }
        } catch {
            // Fall through — conda run can fail even when the env exists
        }

        // 2. Query conda/mamba env list to find the actual env path.
        //    This is more reliable than guessing installation roots because
        //    conda tracks envs in ~/.conda/environments.txt and can find
        //    envs outside the standard <root>/envs/ directory.
        try {
            const { execSync } = await import('child_process');
            const output = execSync(`${best.cmd} env list --json`, { encoding: 'utf-8' });
            const result = JSON.parse(output);

            for (const envPath of result.envs as string[]) {
                const baseName = path.basename(envPath);
                const resolvedName = (baseName === 'bin' || baseName === '') ? 'base' : baseName;
                if (resolvedName === envName) {
                    const pythonPath = path.join(
                        envPath,
                        isWindows ? 'python.exe' : 'bin/python'
                    );
                    try {
                        await fs.promises.access(pythonPath);
                        return pythonPath;
                    } catch {
                        // Python missing in this env — keep searching
                    }
                }
            }
        } catch {
            // Unable to query env list
        }

        // 3. Last resort: direct path fallback using discovered installations
        const installations = await this.getInstallations();
        for (const inst of installations) {
            const envDir = envName === 'base'
                ? inst.rootPath
                : path.join(inst.rootPath, 'envs', envName);
            const pythonPath = path.join(
                envDir,
                isWindows ? 'python.exe' : 'bin/python'
            );

            try {
                await fs.promises.access(pythonPath);
                return pythonPath;
            } catch {
                // Not in this installation
            }
        }

        return undefined;
    }

    /**
     * Get cached installations or discover them.
     */
    async getInstallations(): Promise<CondaInstallation[]> {
        if (!this.cachedInstallations) {
            this.cachedInstallations = await this.resolver.findInstallations();
        }
        return this.cachedInstallations;
    }

    /**
     * Clear the cached installation list.
     */
    clearCache(): void {
        this.cachedInstallations = undefined;
    }

    /**
     * Expose the underlying resolver so other services can query conda/mamba.
     */
    getResolver(): CondaResolver {
        return this.resolver;
    }
}
