// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

/**
 * Pyenv Provider
 *
 * Discovers Python installations managed by `pyenv`.
 *
 * @implements {EnvironmentProvider}
 * @see {@link EnvironmentProvider}
 * @module nuke-core/node
 */

import { NukeEnvironment } from '../../../../common/nuke-core-protocol';
import { EnvironmentProvider } from './base';
import { getPythonInfo } from '../utils/python-info';

export class PyenvProvider implements EnvironmentProvider {
    /** Human-readable provider name */
    readonly name = 'pyenv';

    /**
     * Check whether `pyenv` is available on the system.
     * @returns Promise resolving to true if pyenv is installed and executable
     */
    async isAvailable(): Promise<boolean> {
        try {
            const { execSync } = await import('child_process');
            execSync('pyenv --version', { stdio: 'ignore' });
            return true;
        } catch {
            return false;
        }
    }

    /**
     * List all Python versions managed by pyenv via `pyenv versions --bare`.
     * @returns Promise resolving to an array of detected pyenv environments
     */
    async listEnvironments(): Promise<NukeEnvironment[]> {
        const environments: NukeEnvironment[] = [];
        const path = await import('path');
        const isWindows = process.platform === 'win32';

        try {
            const { execSync } = await import('child_process');
            const output = execSync('pyenv versions --bare', {
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'ignore']
            });

            const lines = output.trim().split(/\r?\n/);
            for (const line of lines) {
                const versionName = line.trim();
                if (!versionName) {
                    continue;
                }

                try {
                    const prefixOutput = execSync(`pyenv prefix "${versionName}"`, {
                        encoding: 'utf-8',
                        stdio: ['pipe', 'pipe', 'ignore']
                    }).trim();

                    if (!prefixOutput) {
                        continue;
                    }

                    const pythonPath = path.join(
                        prefixOutput,
                        isWindows ? 'python.exe' : 'bin/python'
                    );

                    const fs = await import('fs');
                    await fs.promises.access(pythonPath);
                    const envInfo = await getPythonInfo(pythonPath, 'pyenv');
                    if (envInfo) {
                        envInfo.name = versionName;
                        environments.push(envInfo);
                    }
                } catch {
                    // Skip versions that can't be resolved
                }
            }
        } catch {
            // pyenv not available or error parsing output
        }

        return environments;
    }

    /**
     * Resolve the Python executable for a named pyenv version.
     * @param envName - Pyenv version name (defaults to 'system')
     * @returns Promise resolving to the absolute path to the Python executable, or undefined
     */
    async findPython(envName?: string): Promise<string | undefined> {
        const path = await import('path');
        const isWindows = process.platform === 'win32';

        try {
            const { execSync } = await import('child_process');
            const prefixOutput = execSync(`pyenv prefix "${envName || 'system'}"`, {
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'ignore']
            }).trim();

            if (!prefixOutput) {
                return undefined;
            }

            const pythonPath = path.join(
                prefixOutput,
                isWindows ? 'python.exe' : 'bin/python'
            );

            const fs = await import('fs');
            await fs.promises.access(pythonPath);
            return pythonPath;
        } catch {
            return undefined;
        }
    }
}
