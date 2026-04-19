// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

/**
 * Pyenv Provider
 *
 * Discovers pyenv Python installations.
 *
 * @module nuke-core/node
 */

import { NukeEnvironment } from '../../../../common/nuke-core-protocol';
import { EnvironmentProvider } from './base';
import { getPythonInfo } from '../utils/python-info';

export class PyenvProvider implements EnvironmentProvider {
    readonly name = 'pyenv';

    async isAvailable(): Promise<boolean> {
        try {
            const { execSync } = await import('child_process');
            execSync('pyenv --version', { stdio: 'ignore' });
            return true;
        } catch {
            return false;
        }
    }

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
