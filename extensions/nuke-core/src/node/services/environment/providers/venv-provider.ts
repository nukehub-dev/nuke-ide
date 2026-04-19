// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

/**
 * Venv Provider
 *
 * Discovers virtualenv / venv environments in the workspace.
 *
 * @module nuke-core/node
 */

import { NukeEnvironment } from '../../../../common/nuke-core-protocol';
import { EnvironmentProvider } from './base';
import { getPythonInfo } from '../utils/python-info';

export class VenvProvider implements EnvironmentProvider {
    readonly name = 'venv';

    async isAvailable(): Promise<boolean> {
        const venvs = await this.findWorkspaceVenvs();
        return venvs.length > 0;
    }

    async listEnvironments(): Promise<NukeEnvironment[]> {
        return this.findWorkspaceVenvs();
    }

    async findPython(envName?: string): Promise<string | undefined> {
        const venvs = await this.findWorkspaceVenvs();
        const match = venvs.find(v => v.name === envName || v.name === `${envName} (workspace)`);
        return match?.pythonPath;
    }

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
