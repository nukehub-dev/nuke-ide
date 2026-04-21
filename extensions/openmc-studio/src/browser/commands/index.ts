// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// SPDX-License-Identifier: EPL-2.0
// *****************************************************************************

/**
 * OpenMC Studio Browser Commands
 *
 * Re-exports all command namespaces and handlers for the OpenMC Studio extension.
 *
 * - {@link EnvironmentCommands} – Environment health checks and package installation
 * - {@link ProjectCommands} – Project lifecycle (new, open, save)
 * - {@link SimulationCommands} – Simulation run/stop/validate and XML I/O
 * - {@link ViewCommands} – Opening widgets and dashboard tabs
 *
 * @see {@link OpenMCCommandContribution} for the aggregate command contribution
 * @module openmc-studio/browser/commands
 */

export * from './environment-commands';
export * from './project-commands';
export * from './simulation-commands';
export * from './view-commands';
