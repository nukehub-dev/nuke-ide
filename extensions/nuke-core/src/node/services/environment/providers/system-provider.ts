// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

/**
 * System Python Provider
 *
 * Discovers system-wide Python installations.
 *
 * @module nuke-core/node
 */

import { NukeEnvironment } from '../../../../common/nuke-core-protocol';
import { EnvironmentProvider } from './base';
import { getPythonInfo } from '../utils/python-info';

export class SystemProvider implements EnvironmentProvider {
    readonly name = 'system';

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

    async listEnvironments(): Promise<NukeEnvironment[]> {
        const environments: NukeEnvironment[] = [];
        for (const cmd of ['python3', 'python']) {
            try {
                const { execSync } = await import('child_process');
                execSync(`${cmd} --version`, { stdio: 'ignore' });
                const env = await getPythonInfo(cmd, 'system');
                if (env && !environments.find(e => e.pythonPath === env.pythonPath)) {
                    environments.push(env);
                }
            } catch {
                // Not found
            }
        }
        return environments;
    }

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
