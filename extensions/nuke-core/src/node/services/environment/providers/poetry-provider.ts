// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

/**
 * Poetry Provider
 *
 * Discovers Poetry virtual environments.
 *
 * @module nuke-core/node
 */

import { NukeEnvironment } from '../../../../common/nuke-core-protocol';
import { EnvironmentProvider } from './base';
import { getPythonInfo } from '../utils/python-info';

export class PoetryProvider implements EnvironmentProvider {
    readonly name = 'poetry';

    async isAvailable(): Promise<boolean> {
        try {
            const { execSync } = await import('child_process');
            execSync('poetry --version', { stdio: 'ignore' });
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
