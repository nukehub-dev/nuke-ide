// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

/**
 * Nuke Core Commands
 *
 * Command definitions and contributions for Nuke Core.
 *
 * @module nuke-core/browser/commands
 */

export namespace NukeCoreCommands {
    export const HEALTH_CHECK = {
        id: 'nuke.core.healthCheck',
        label: 'Nuke: Run Health Check'
    };

    export const DIAGNOSTICS = {
        id: 'nuke.core.diagnostics',
        label: 'Nuke: Show Diagnostics'
    };

    export const VALIDATE_CONFIG = {
        id: 'nuke.core.validateConfig',
        label: 'Nuke: Validate Configuration'
    };

    export const SWITCH_ENVIRONMENT = {
        id: 'nuke.core.switchEnvironment',
        label: 'Nuke: Switch Environment'
    };

    export const INSTALL_PACKAGE = {
        id: 'nuke.core.installPackage',
        label: 'Nuke: Install Package'
    };

    export const CREATE_ENVIRONMENT = {
        id: 'nuke.core.createEnvironment',
        label: 'Nuke: Create Environment'
    };

    export const DELETE_ENVIRONMENT = {
        id: 'nuke.core.deleteEnvironment',
        label: 'Nuke: Delete Environment'
    };

    export const ENVIRONMENT_ACTIONS = {
        id: 'nuke.core.environmentActions',
        label: 'Nuke: Environment Actions'
    };
}

export * from './health-command-contribution';
export * from './environment-command-contribution';
export * from './package-command-contribution';
