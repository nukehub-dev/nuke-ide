// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0
// *****************************************************************************

/**
 * Barrel module for Nuke Core browser contributions.
 *
 * Re-exports the frontend contribution classes that integrate Nuke Core with
 * Theia's workbench lifecycle and UI surfaces (status bar, workspace scanning,
 * environment quick-picks, etc.).
 *
 * @module nuke-core/browser/contributions
 * @see {@link NukeCoreStatusBarContribution}
 * @see {@link WorkspaceEnvContribution}
 */

export * from './status-bar-contribution';
export * from './workspace-env-contribution';
