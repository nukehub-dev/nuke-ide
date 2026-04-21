// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

/**
 * Venv Provider
 *
 * Discovers virtualenv / venv environments located in the current workspace.
 * Searches for common directory names such as `venv`, `.venv`, `env`, `.env`,
 * and `virtualenv`.
 *
 * @implements {EnvironmentProvider}
 * @see {@link EnvironmentProvider}
 * @module nuke-core/node
 */

import { NukeEnvironment } from '../../../../common/nuke-core-protocol';
import { EnvironmentProvider } from './base';
import { getPythonInfo } from '../utils/python-info';

export class VenvProvider implements EnvironmentProvider {
    /** Human-readable provider name */
    readonly name = 'venv';

    /**
     * Check whether any workspace virtual environments exist.
     * @returns Promise resolving to true if at least one workspace venv is found
     */
    async isAvailable(): Promise<boolean> {
        const venvs = await this.findWorkspaceVenvs();
        return venvs.length > 0;
    }

    /**
     * List all virtual environments found in the current workspace.
     * @returns Promise resolving to an array of detected workspace venv environments
     */
    async listEnvironments(): Promise<NukeEnvironment[]> {
        return this.findWorkspaceVenvs();
    }

    /**
     * Resolve the Python executable for a named workspace venv.
     * @param envName - Name of the virtual environment directory
     * @returns Promise resolving to the absolute path to the Python executable, or undefined
     */
    async findPython(envName?: string): Promise<string | undefined> {
        const venvs = await this.findWorkspaceVenvs();
        const match = venvs.find(v => v.name === envName || v.name === `${envName} (workspace)`);
        return match?.pythonPath;
    }

    /**
     * Search the current working directory for common virtual environment folders.
     * @returns Promise resolving to an array of detected workspace venv environments
     */
    private async findWorkspaceVenvs(): Promise<NukeEnvironment[]> {
        const environments: NukeEnvironment[] = [];
        const path = await import('path');
        const fs = await import('fs');

        try {
            const workspaceRoot = process.cwd();
            const commonVenvNames = ['venv', '.venv', 'env', '.env', 'virtualenv'];
            const isWindows = process.platform === 'win32';

            for (const venvName of commonVenvNames) {
                const venvPath = path.join(workspaceRoot, venvName);
                const pythonPath = path.join(
                    venvPath,
                    isWindows ? 'Scripts\\python.exe' : 'bin/python'
                );

                try {
                    await fs.promises.access(pythonPath);
                    const env = await getPythonInfo(pythonPath, 'venv');
                    if (env) {
                        env.name = `${venvName} (workspace)`;
                        environments.push(env);
                    }
                } catch {
                    // Ignore missing venvs
                }
            }
        } catch {
            // Ignore errors
        }

        return environments;
    }
}
