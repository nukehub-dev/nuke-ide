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
 * OpenMC Studio Browser Services
 *
 * Barrel export for all OpenMC Studio browser-side services.
 *
 * @see {@link OpenMCEnvironmentService} for environment management
 * @see {@link OpenMCHealthService} for health checks
 * @see {@link OpenMCInstallerService} for package installation
 * @see {@link getOpenMCHealthPackages} for shared package metadata
 * @module openmc-studio/browser/services
 */

export * from './openmc-environment-service';
export * from './openmc-health-service';
export * from './openmc-installer-service';
export * from './openmc-package-metadata';
