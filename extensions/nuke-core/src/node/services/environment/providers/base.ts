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
