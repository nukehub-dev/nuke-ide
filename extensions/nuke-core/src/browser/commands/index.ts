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
 * Nuke Core Commands
 *
 * Central registry of all command identifiers used across Nuke Core.
 * Each constant pairs a unique command ID with a human-readable label.
 *
 * @see {@link NukeHealthCommandContribution}
 * @see {@link NukeEnvironmentCommandContribution}
 * @see {@link NukePackageCommandContribution}
 *
 * @module nuke-core/browser/commands
 */

export namespace NukeCoreCommands {
    /** Run a full health check across Nuke Core subsystems. */
    export const HEALTH_CHECK = {
        id: 'nuke.core.healthCheck',
        label: 'Nuke: Run Health Check'
    };

    /** Display detailed runtime diagnostics in the output panel. */
    export const DIAGNOSTICS = {
        id: 'nuke.core.diagnostics',
        label: 'Nuke: Show Diagnostics'
    };

    /** Validate the current Nuke Core configuration and report errors or warnings. */
    export const VALIDATE_CONFIG = {
        id: 'nuke.core.validateConfig',
        label: 'Nuke: Validate Configuration'
    };

    /** Switch the active Python environment used by Nuke. */
    export const SWITCH_ENVIRONMENT = {
        id: 'nuke.core.switchEnvironment',
        label: 'Nuke: Switch Environment'
    };

    /** Install one or more packages into the active environment. */
    export const INSTALL_PACKAGE = {
        id: 'nuke.core.installPackage',
        label: 'Nuke: Install Package'
    };

    /** Create a new conda or virtualenv Python environment. */
    export const CREATE_ENVIRONMENT = {
        id: 'nuke.core.createEnvironment',
        label: 'Nuke: Create Environment'
    };

    /** Delete an existing Python environment with typed confirmation. */
    export const DELETE_ENVIRONMENT = {
        id: 'nuke.core.deleteEnvironment',
        label: 'Nuke: Delete Environment'
    };

    /** Open the environment actions picker for managing an existing environment. */
    export const ENVIRONMENT_ACTIONS = {
        id: 'nuke.core.environmentActions',
        label: 'Nuke: Environment Actions'
    };
}

export * from './health-command-contribution';
export * from './environment-command-contribution';
export * from './package-command-contribution';
