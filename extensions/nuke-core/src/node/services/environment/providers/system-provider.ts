// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
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
                if (env && !environments.find(e => e.pythonPath === env.pythonPath)) {
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
