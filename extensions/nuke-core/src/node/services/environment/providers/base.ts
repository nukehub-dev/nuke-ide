// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

/**
 * Environment Provider Base Interface
 *
 * @module nuke-core/node
 */

import { NukeEnvironment } from '../../../../common/nuke-core-protocol';

/**
 * Base interface for all environment providers.
 *
 * Defines the contract used by {@link EnvironmentService} to discover and resolve
 * Python interpreters across different environment managers (conda, venv, poetry,
 * pyenv, system).
 *
 * @see {@link CondaProvider}
 * @see {@link VenvProvider}
 * @see {@link PoetryProvider}
 * @see {@link PyenvProvider}
 * @see {@link SystemProvider}
 */
export interface EnvironmentProvider {
    /** Human-readable provider name */
    readonly name: string;

    /**
     * Check whether this provider can discover environments on the system.
     * @returns Promise resolving to true if the provider's underlying tool is installed and usable
     */
    isAvailable(): Promise<boolean>;

    /**
     * List all environments discoverable by this provider.
     * @returns Promise resolving to an array of detected environments
     */
    listEnvironments(): Promise<NukeEnvironment[]>;

    /**
     * Resolve the Python executable for a named environment (if applicable).
     * @param envName - Environment name (provider-specific)
     * @returns Promise resolving to the absolute path to the Python executable, or undefined if not found
     */
    findPython(envName?: string): Promise<string | undefined>;
}
