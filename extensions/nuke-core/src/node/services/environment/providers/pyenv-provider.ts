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
