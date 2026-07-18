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
 * System Python Provider
 *
 * Discovers system-wide Python installations (`python3`, `python`).
 *
 * @implements {EnvironmentProvider}
 * @see {@link EnvironmentProvider}
 * @module nuke-core/node
 */

import { NukeEnvironment } from '../../../../common/nuke-core-protocol';
import { EnvironmentProvider } from './base';
import { getPythonInfo } from '../utils/python-info';

export class SystemProvider implements EnvironmentProvider {
    /** Human-readable provider name */
    readonly name = 'system';

    /**
     * Check whether a system Python (`python3` or `python`) is available.
     * @returns Promise resolving to true if a system Python is found
     */
    async isAvailable(): Promise<boolean> {
        for (const cmd of ['python3', 'python']) {
            try {
                const { execSync } = await import('child_process');
                execSync(`${cmd} --version`, { stdio: 'ignore' });
                return true;
            } catch {
                // Try next
            }
        }
        return false;
    }

    /**
     * List all system-wide Python installations by probing `python3` and `python`.
     * Duplicates are filtered out by executable path.
     * @returns Promise resolving to an array of detected system environments
     */
    async listEnvironments(): Promise<NukeEnvironment[]> {
        const environments: NukeEnvironment[] = [];
        for (const cmd of ['python3', 'python']) {
            try {
                const { execSync } = await import('child_process');
                execSync(`${cmd} --version`, { stdio: 'ignore' });
                const env = await getPythonInfo(cmd, 'system');
                if (env && !environments.find((e) => e.pythonPath === env.pythonPath)) {
                    environments.push(env);
                }
            } catch {
                // Not found
            }
        }
        return environments;
    }

    /**
     * Resolve the first available system Python command.
     * @param _envName - Unused; system provider does not use named environments
     * @returns Promise resolving to the command string (`python3` or `python`), or undefined
     */
    async findPython(_envName?: string): Promise<string | undefined> {
        for (const cmd of ['python3', 'python']) {
            try {
                const { execSync } = await import('child_process');
                execSync(`${cmd} --version`, { stdio: 'ignore' });
                return cmd;
            } catch {
                // Try next
            }
        }
        return undefined;
    }
}
