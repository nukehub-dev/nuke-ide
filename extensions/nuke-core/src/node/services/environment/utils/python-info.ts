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
 * Python Info Utility
 *
 * Extracts environment metadata from a Python executable.
 *
 * @module nuke-core/node
 */

import { NukeEnvironment } from '../../../../common/nuke-core-protocol';

/**
 * Get environment information from a Python executable path.
 *
 * @param pythonPath - Absolute or relative path to a Python executable.
 * @param type - Environment type label (e.g., `conda`, `system`, `venv`).
 * @returns `NukeEnvironment` object, or `undefined` if the executable is invalid.
 * @see {@link CondaResolver} for conda environment discovery.
 * @see {@link UvResolver} for uv-based environment discovery.
 */
export async function getPythonInfo(
    pythonPath: string,
    type: NukeEnvironment['type']
): Promise<NukeEnvironment | undefined> {
    try {
        const { execSync } = await import('child_process');
        const path = await import('path');

        const versionOutput = execSync(`"${pythonPath}" --version`, { encoding: 'utf-8' }).trim();
        const versionMatch = versionOutput.match(/Python (\d+\.\d+\.\d+)/);
        const version = versionMatch ? versionMatch[1] : undefined;

        let name: string;

        if (type === 'conda') {
            // For conda, derive name from the env directory
            const pythonDir = path.dirname(pythonPath);       // .../bin or .../Scripts
            const envDir = path.dirname(pythonDir);           // .../envName or .../base
            name = path.basename(envDir);
            if (name === 'bin' || name === 'Scripts' || name === 'lib') {
                name = 'base';
            }
        } else if (type === 'system') {
            name = 'system';
        } else {
            // venv, virtualenv, etc.
            name = path.basename(path.dirname(path.dirname(pythonPath))) || 'venv';
        }

        const envPath = path.dirname(path.dirname(pythonPath));

        return {
            name,
            pythonPath,
            type,
            version,
            envPath
        };
    } catch {
        return undefined;
    }
}
