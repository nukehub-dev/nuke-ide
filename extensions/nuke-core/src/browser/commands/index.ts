// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
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
