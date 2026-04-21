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
 * Poetry Provider
 *
 * Discovers Poetry-managed virtual environments via the `poetry` CLI.
 *
 * @implements {EnvironmentProvider}
 * @see {@link EnvironmentProvider}
 * @module nuke-core/node
 */

import { NukeEnvironment } from '../../../../common/nuke-core-protocol';
import { EnvironmentProvider } from './base';
import { getPythonInfo } from '../utils/python-info';

export class PoetryProvider implements EnvironmentProvider {
    /** Human-readable provider name */
    readonly name = 'poetry';

    /**
     * Check whether the `poetry` CLI is available on the system.
     * @returns Promise resolving to true if poetry is installed and executable
     */
    async isAvailable(): Promise<boolean> {
        try {
            const { execSync } = await import('child_process');
            execSync('poetry --version', { stdio: 'ignore' });
            return true;
        } catch {
            return false;
        }
    }

    /**
     * List all Poetry virtual environments by querying `poetry env list --full-path`.
     * @returns Promise resolving to an array of detected poetry environments
     */
    async listEnvironments(): Promise<NukeEnvironment[]> {
        const environments: NukeEnvironment[] = [];
        const path = await import('path');
        const isWindows = process.platform === 'win32';

        try {
            const { execSync } = await import('child_process');
            const output = execSync('poetry env list --full-path', {
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'ignore']
            });

            const lines = output.trim().split(/\r?\n/);
            for (const line of lines) {
                const envPath = line.replace(/\s*\(Activated\)\s*$/, '').trim();
                if (!envPath) {
                    continue;
                }

                const pythonPath = path.join(
                    envPath,
                    isWindows ? 'Scripts\\python.exe' : 'bin/python'
                );

                try {
                    const fs = await import('fs');
                    await fs.promises.access(pythonPath);
                    const envInfo = await getPythonInfo(pythonPath, 'poetry');
                    if (envInfo) {
                        // Derive a friendly name from the virtualenv path
                        const baseName = path.basename(envPath);
                        envInfo.name = baseName;
                        environments.push(envInfo);
                    }
                } catch {
                    // Python executable not found in this env
                }
            }
        } catch {
            // Poetry not available or error parsing output
        }

        return environments;
    }

    /**
     * Resolve the Python executable for the currently active Poetry environment.
     * @param _envName - Unused; poetry resolves the active project environment
     * @returns Promise resolving to the absolute path to the Python executable, or undefined
     */
    async findPython(_envName?: string): Promise<string | undefined> {
        const path = await import('path');
        const isWindows = process.platform === 'win32';

        try {
            const { execSync } = await import('child_process');
            const output = execSync('poetry env info --path', {
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'ignore']
            }).trim();

            if (!output) {
                return undefined;
            }

            const pythonPath = path.join(
                output,
                isWindows ? 'Scripts\\python.exe' : 'bin/python'
            );

            const fs = await import('fs');
            await fs.promises.access(pythonPath);
            return pythonPath;
        } catch {
            return undefined;
        }
    }
}
