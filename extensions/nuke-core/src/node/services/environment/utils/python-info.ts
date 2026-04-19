// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
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
 * @param pythonPath - Absolute or relative path to a Python executable
 * @param type - Environment type label
 * @returns NukeEnvironment object or undefined if the executable is invalid
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
