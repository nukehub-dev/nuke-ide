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

export interface EnvironmentProvider {
    /** Human-readable provider name */
    readonly name: string;

    /** Check whether this provider can discover environments on the system */
    isAvailable(): Promise<boolean>;

    /** List all environments discoverable by this provider */
    listEnvironments(): Promise<NukeEnvironment[]>;

    /**
     * Resolve the Python executable for a named environment (if applicable).
     * @param envName - Environment name (provider-specific)
     * @returns Path to Python executable, or undefined
     */
    findPython(envName?: string): Promise<string | undefined>;
}
